# Build spec — the AI Feature Pipeline in this starter

Step-by-step, adapted to **supabase-vibe-starter** conventions: plain CSS (no
tailwind), no router (App switches on session), timestamp-prefixed migrations
mirroring the `documents` shape, and an **edge-function secret** for the GitHub
token (this starter has no vault). Ground-truth source is in `../origin-source/`;
`../origin-source/ORIGIN.md` shows what each adapted file changed and why.

Build it as one feature branch, then approve *itself* through the board as the
first end-to-end test. 😄

---

## §0 Prerequisites

- The base starter works (auth + `documents` + RLS + realtime + storage).
- The repo is on GitHub and **merges to `main` deploy** (Railway is wired). Turn on
  **branch protection for `main`** (require a PR; no direct pushes).
- You can set **edge-function secrets** and **GitHub Actions secrets**, and can
  change repo **Actions settings** (see §6 — Actions must be allowed to open PRs).
- Decide who is an admin. This spec adds a minimal `profiles.is_admin` (first
  signup = admin). If your project already has roles, use those instead and skip §1a.

---

## §1 Database

### §1a Minimal admin trust boundary — `profiles`

`<timestamp>_profiles_admin.sql` (use a timestamp after your latest migration):

```sql
-- Minimal roles: one profiles row per user, first signup is the admin.
-- The feature needs a trust boundary for "approve" (spends AI $ / opens a public
-- issue) and "merge" (ships to prod). If you already have roles, use them instead.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Everyone signed in can read profiles (the board needs to know "am I admin?").
create policy "read profiles" on public.profiles
  for select using (auth.uid() is not null);

-- A user may create/patch only their own row, and may NOT self-promote:
-- is_admin can only be set by the trigger below or by the service role.
create policy "insert own profile" on public.profiles
  for insert with check (id = auth.uid() and is_admin = false);
create policy "update own profile" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid() and is_admin = false);

-- Auto-create a profile on signup; the very first user becomes admin.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, is_admin)
  values (new.id, new.email, not exists (select 1 from public.profiles));
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

> Security note: the RLS check `is_admin = false` on insert/update stops a user
> from promoting themselves via the client. Only the `security definer` trigger and
> the service role set `is_admin = true`. To make someone an admin later, flip the
> flag from the SQL editor (service role).

### §1b The `features` table

`<timestamp>_features_board.sql`:

```sql
-- Features board: the self-improvement pipeline as a kanban.
-- Lanes: idea → approved (issue opened) → ready (PR merged) → shipped.
create table public.features (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  screenshots jsonb not null default '[]'::jsonb,  -- storage paths in the documents bucket
  lane text not null default 'idea' check (lane in ('idea','approved','ready','shipped')),
  position integer not null default 0,
  issue_number integer,
  pr_number integer,
  pr_url text,
  pr_state text,             -- open | merged | closed (synced)
  last_error text,           -- last approve/merge/sync failure, shown on the card
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.features enable row level security;

-- Workspace-visible; anyone signed in can file an idea. Lane moves + edits are
-- admin-only, EXCEPT the owner may edit/delete their own card while it's an idea
-- (before any GitHub side effects exist).
create policy "members read features" on public.features
  for select using (auth.uid() is not null);

create policy "members file ideas" on public.features
  for insert with check (owner_id = auth.uid() and lane = 'idea');

create policy "admins update features" on public.features
  for update using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "owners edit their ideas" on public.features
  for update using (owner_id = auth.uid() and lane = 'idea')
  with check (owner_id = auth.uid() and lane = 'idea');

create policy "admins delete features" on public.features
  for delete using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "owners delete their ideas" on public.features
  for delete using (owner_id = auth.uid() and lane = 'idea');

-- Live board: PR links land asynchronously via the edge function's sync; without
-- realtime they'd only show after a manual reload.
alter publication supabase_realtime add table public.features;
```

> Note: lane moves that have side effects (`approved`, `ready`) are *also* routed
> through the edge function, which runs as the service role and re-checks
> `is_admin` in code. The RLS above is the second lock; the code check is the first.

---

## §2 The `features` edge function

Create `supabase/functions/features/index.ts`. This is the adapted version — it
reads the GitHub token from the **`GITHUB_PAT` edge secret** (no vault) and drops
the origin's `activity_log` writes (this starter has none; add them back if you
introduce an audit log).

```ts
// supabase/functions/features/index.ts  (verify_jwt=true, ADMIN ONLY)
// The GitHub side of the Features kanban: approve → open a labeled issue;
// sync → find + refresh the linked PR; merge → squash-merge (= deploy).
import { createClient } from 'npm:@supabase/supabase-js@2'

const GITHUB_REPO = Deno.env.get('GITHUB_REPO') ?? 'you/your-repo'
const GH_API = 'https://api.github.com'
const APPROVED_LABEL = 'approved-for-work'
const BUCKET = 'documents' // this starter's private bucket

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// verify_jwt=true means the gateway already validated the token; we only need the sub.
function userIdFromAuth(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof p.sub === 'string' ? p.sub : null
  } catch { return null }
}

// deno-lint-ignore no-explicit-any
async function gh(pat: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data: unknown = null
  try { data = await res.json() } catch { /* some endpoints are empty */ }
  return { ok: res.ok, status: res.status, data }
}

// deno-lint-ignore no-explicit-any
type DB = any

async function issueBody(db: DB, feature: { description: string; screenshots: string[]; id: string }): Promise<string> {
  const parts = [feature.description || '(no description provided)']
  const shots: string[] = []
  for (const path of feature.screenshots ?? []) {
    // 24h signed URLs: on a public repo the issue is world-readable, so keep the
    // window short — it only bounds NEW reads of the private original.
    const { data } = await db.storage.from(BUCKET).createSignedUrl(path, 24 * 3600)
    if (data?.signedUrl) shots.push(`![screenshot](${data.signedUrl})`)
  }
  if (shots.length) parts.push('## Screenshots', shots.join('\n\n'))
  parts.push(
    '---',
    '_Filed from the Features board. Implement this, run `npm run build` + `npm test`, and open a PR whose description contains `Closes #<this issue>`. Do not push to main._',
    `<!-- feature:${feature.id} -->`,
  )
  return parts.join('\n\n')
}

async function findLinkedPr(pat: string, issueNumber: number): Promise<{ number: number; url: string } | null> {
  const { ok, data } = await gh(pat, 'GET', `/repos/${GITHUB_REPO}/issues/${issueNumber}/timeline?per_page=100`)
  if (!ok || !Array.isArray(data)) return null
  let found: { number: number; url: string } | null = null
  for (const ev of data) {
    const src = ev?.source?.issue
    if (ev?.event === 'cross-referenced' && src?.pull_request && src?.number) {
      found = { number: src.number, url: src.pull_request.html_url ?? src.html_url }
    }
  }
  return found
}

async function syncRow(db: DB, pat: string, row: { id: string; issue_number: number | null; pr_number: number | null }) {
  let prNumber = row.pr_number
  let prUrl: string | undefined
  if (!prNumber && row.issue_number) {
    const linked = await findLinkedPr(pat, row.issue_number)
    if (linked) { prNumber = linked.number; prUrl = linked.url }
  }
  if (!prNumber) return { pr_number: null, pr_state: null }
  const { ok, data } = await gh(pat, 'GET', `/repos/${GITHUB_REPO}/pulls/${prNumber}`)
  if (!ok) return { pr_number: prNumber, pr_state: null }
  const state = data.merged ? 'merged' : data.state
  const update: Record<string, unknown> = {
    pr_number: prNumber, pr_url: prUrl ?? data.html_url, pr_state: state, updated_at: new Date().toISOString(),
  }
  if (state === 'merged') update.lane = 'shipped'
  await db.from('features').update(update).eq('id', row.id)
  return update
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const userId = userIdFromAuth(req)
  if (!userId) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  if (!profile?.is_admin) return json({ error: 'Admins only.' }, 403)

  const pat = Deno.env.get('GITHUB_PAT')
  if (!pat) return json({ error: 'Set the GITHUB_PAT edge secret (a token with repo/issues/PR scope).' }, 400)

  let body: { action?: string; id?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body.' }, 400) }
  const { action, id } = body
  if (!id) return json({ error: 'id is required.' }, 400)

  const { data: feature } = await db.from('features').select('*').eq('id', id).maybeSingle()
  if (!feature) return json({ error: 'Feature not found.' }, 404)

  try {
    if (action === 'approve') {
      if (feature.issue_number) return json({ error: 'An issue already exists for this feature.' }, 400)
      const { ok, status, data } = await gh(pat, 'POST', `/repos/${GITHUB_REPO}/issues`, {
        title: feature.title, body: await issueBody(db, feature), labels: [APPROVED_LABEL],
      })
      if (!ok) {
        const msg = `GitHub issue creation failed (${status}): ${data?.message ?? 'unknown'}`
        await db.from('features').update({ last_error: msg, updated_at: new Date().toISOString() }).eq('id', id)
        return json({ error: msg }, 502)
      }
      await db.from('features').update({
        lane: 'approved', issue_number: data.number, last_error: null, updated_at: new Date().toISOString(),
      }).eq('id', id)
      return json({ ok: true, issue_number: data.number, issue_url: data.html_url })
    }

    if (action === 'sync') return json({ ok: true, ...(await syncRow(db, pat, feature)) })

    if (action === 'merge') {
      const synced = await syncRow(db, pat, feature)
      const prNumber = (synced.pr_number as number | null) ?? feature.pr_number
      if (!prNumber) return json({ error: 'No PR is linked to this feature yet.' }, 400)
      if (synced.pr_state === 'merged') return json({ ok: true, already: true })
      const { ok, status, data } = await gh(pat, 'PUT', `/repos/${GITHUB_REPO}/pulls/${prNumber}/merge`, { merge_method: 'squash' })
      if (!ok) {
        const msg = `Merge failed (${status}): ${data?.message ?? 'unknown'}`
        await db.from('features').update({ last_error: msg, lane: 'ready', updated_at: new Date().toISOString() }).eq('id', id)
        return json({ error: msg }, 502)
      }
      await db.from('features').update({
        lane: 'shipped', pr_state: 'merged', last_error: null, updated_at: new Date().toISOString(),
      }).eq('id', id)
      return json({ ok: true })
    }

    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'error' }, 500)
  }
})
```

Register it in `supabase/config.toml`:

```toml
[functions.features]
verify_jwt = true
```

---

## §3 Pure list helpers (drop-in, verbatim)

Copy `../origin-source/features.ts` → `src/lib/features.ts` and
`../origin-source/features.test.ts` → `src/lib/features.test.ts` **unchanged** — they
are stack-agnostic and already unit-tested (this is exactly the `format.ts` +
`format.test.ts` pattern the starter uses). `upsertFeature` merges a Realtime
INSERT/UPDATE into the list keeping `updated_at`-desc order; `removeFeature` handles
DELETE.

---

## §4 The board UI

Create `src/components/FeaturesBoard.tsx` — a plain-CSS kanban matching the
starter's component style (takes `session`, uses `supabase`, no router, no tailwind).
The full adapted component is long; the shape is:

- Load `features` (RLS returns all rows to signed-in users), order by `updated_at`.
- Read `profiles.is_admin` for the current user → `isAdmin`.
- Subscribe to `postgres_changes` on `features` and fold events through
  `upsertFeature` / `removeFeature`.
- Render four lane columns; cards are `draggable={isAdmin}`; `onDrop` calls `moveTo`.
- `moveTo(feature, lane)`:
  - `approved` (no issue yet) → `confirm()` the public-issue warning, then call the
    edge function `approve`.
  - `ready` → `confirm()` the deploy warning, set lane `ready` in the table, then
    call the edge function `merge`.
  - otherwise → a plain `features` table `update({ lane })`.
- A "New idea" modal uploads screenshots to the `documents` bucket under
  `${userId}/features/…` and inserts a `lane:'idea'` row.

The edge-function call helper:

```ts
async function callFeaturesFn(action: 'approve' | 'sync' | 'merge', id: string) {
  const { data: sess } = await supabase.auth.getSession()
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/features`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sess.session?.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action, id }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body
}
```

**Port the JSX from `../origin-source/FeaturesPage.tsx`**, swapping tailwind classes for
plain classes. Suggested CSS to append to `src/index.css`:

```css
/* Features board */
.board { display: flex; gap: 1rem; overflow-x: auto; padding: 1rem 0; }
.lane { display: flex; flex-direction: column; width: 18rem; flex: 0 0 auto;
        border: 1px solid var(--border, #e5e7eb); border-radius: 0.75rem; background: #fafafa; }
.lane.over { border-color: #6366f1; box-shadow: 0 0 0 2px #c7d2fe; }
.lane-head { padding: 0.75rem 0.75rem 0.25rem; }
.lane-head h2 { font-size: 0.85rem; margin: 0; }
.lane-hint { font-size: 0.7rem; color: #9ca3af; margin: 0.15rem 0 0; }
.lane-body { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; overflow-y: auto; }
.feat-card { border: 1px solid var(--border, #e5e7eb); border-radius: 0.5rem; background: #fff;
             padding: 0.75rem; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
.feat-card:hover { border-color: #cbd5e1; }
.feat-title { font-size: 0.85rem; font-weight: 500; }
.feat-desc { font-size: 0.75rem; color: #6b7280; margin: 0.25rem 0 0;
             display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.feat-meta { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.5rem; font-size: 0.7rem; color: #9ca3af; }
.badge { border-radius: 999px; padding: 0.05rem 0.4rem; background: #f1f5f9; }
.badge.pr-open { background: #eef2ff; color: #4f46e5; }
.badge.pr-merged { background: #dcfce7; color: #15803d; }
.badge.pr-closed { background: #fee2e2; color: #b91c1c; }
.badge.building { background: #fef3c7; color: #b45309; }
.feat-error { background: #fef2f2; color: #b91c1c; border-radius: 0.375rem; padding: 0.25rem 0.5rem;
              font-size: 0.7rem; margin-top: 0.5rem; }
```

> If your project uses tailwind or another system, keep `../origin-source/FeaturesPage.tsx`
> as-is instead — it already has a full tailwind implementation.

---

## §5 The Claude Code workflow

Copy `../origin-source/claude-feature.yml` → `.github/workflows/claude-feature.yml` and
adapt the CI steps to this starter's npm scripts (no deno). The final branch-CI step:

```yaml
      - name: Test the built branch
        run: |
          branch="feature/issue-${{ github.event.issue.number }}"
          git fetch origin "$branch"
          git checkout "$branch"
          npm ci
          npm run typecheck
          npm run lint
          npm test
          npm run build
```

Delete the two `denoland/setup-deno` + `deno test` steps (this starter has no edge-
function test suite; add them back if you write Deno tests). Keep everything else —
especially the OpenRouter env wiring and the "Verify a PR was opened" step — exactly
as in the reference (see `github-flow.md` for why each line is there).

---

## §6 Wiring & setup

**Nav (no router):** the starter switches views in `App.tsx`/`Dashboard`. Add a
simple view toggle — e.g. in `Dashboard`, a small tab bar `Documents | Features`
that conditionally renders `<FeaturesBoard session={session} />`. (If you later add
`react-router-dom`, give it a `/features` route instead.)

**Create the label once:**
```bash
gh label create approved-for-work --color 0e8a16 --description "Claude Code builds this"
```

**Secrets:**
```bash
# Edge function (server-side) — the token the features function uses:
supabase secrets set GITHUB_PAT=<a GitHub token with repo, issues, PR scope>
supabase secrets set GITHUB_REPO=<owner>/<repo>

# GitHub Actions (repo → Settings → Secrets and variables → Actions):
#   OPEN_ROUTER_KEY = sk-or-...   (Claude Code runs on OpenRouter billing)
```

**Let Actions open the PR (easy to miss):** enable **repo → Settings → Actions →
General → Workflow permissions → "Allow GitHub Actions to create and approve pull
requests."** It is **off by default**, and without it the workflow *pushes the
branch fine* (job-level `contents: write`) but `gh pr create` gets a **403** — so
the build looks "done," no PR ever appears, and "Verify a PR was opened" fails on
a branch that exists. Enable it once:
```bash
gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
```

**Branch protection:** protect `main` (require a PR, block direct pushes) so the
agent can never merge itself.

---

## §7 Verify (Definition of Done)

- [ ] As a **second, non-admin** user: you can add an idea but cannot drag cards.
- [ ] As the admin: drag an idea to **Approved for work** → a GitHub issue opens
      with the `approved-for-work` label and the public-repo warning fired first.
- [ ] The workflow runs, builds the feature, opens a PR; the card shows a **PR
      badge** (via realtime, no reload). If the branch pushes but no PR opens,
      Actions aren't allowed to create PRs — see §6.
- [ ] The bot's PR ran `typecheck`/`lint`/`test`/`build` green on its branch.
- [ ] Drag to **Approved to merge** → the PR squash-merges, deploy runs, card →
      **Shipped**.
- [ ] `GITHUB_PAT` is only ever an edge secret — never in the client bundle or git.
- [ ] `npm run typecheck && npm run lint && npm test && npm run build` are green.
