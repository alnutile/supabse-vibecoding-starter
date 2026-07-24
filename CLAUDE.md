# CLAUDE.md — supabase-vibe-starter

The "opinion" you bring to a vibe-coded project so the AI builds things
*consistently* and *securely*. This repo is a **GitHub template**: every project
started from it gets Supabase auth, per-user data (RLS), realtime, and file
storage wired **out of the gate**. The full method lives in the
`vibe-coding-with-confidence` skill (`.claude/skills/`) — read it and apply it.

## What this starter already is

Not a hello-world. It ships a working **stack smoke-test**: you must log in, then
you land on a dashboard, upload a document, and see it appear — proving auth,
per-user data + RLS, realtime websockets, and Storage all work end to end.

- **Auth-gated** — no session → login screen (email+password **and** magic link,
  open sign-up, no email verification). No anonymous phase; auth is required.
- **`documents` table** — per-user rows, RLS ON with owner-gated policies for
  select/insert/update/delete, `updated_at` trigger, added to the realtime
  publication.
- **Private Storage bucket `documents`** — RLS on `storage.objects` scopes every
  file to a `{user_id}/…` folder; the app views files via short-lived signed URLs.
- **Realtime** — the dashboard subscribes filtered to the current user, so a
  change in one tab shows up in the others.

See `supabase/migrations/` for the schema and `src/` for the app.

## Stack (defaults — change deliberately, not by accident)

- **Frontend:** Vite + React + TypeScript. (Only `VITE_`-prefixed env vars reach
  the browser — see Security.)
- **Database + auth + realtime + storage:** Supabase.
- **Hosting:** Railway, deploying from GitHub on every push. HTTPS is free.

## Non-negotiable rules (from the skill — never relax these)

- **Never roll your own auth.** Use Supabase Auth.
- **RLS is ON for every table that holds user data** — default-deny, then
  policies gated on `user_id = auth.uid()`. Same for Storage (`storage.objects`).
- **Env var discipline:** only `VITE_`-prefixed values reach the browser (treat
  as PUBLIC). The anon/publishable key is fine client-side. The **`service_role`**
  key is server-only — never in client code, never in a `VITE_` var, never
  committed. `.env` is gitignored; ship `.env.example` placeholders only.
- **HTTPS only.**
- On any security choice you're unsure about, pick the **safer** option and
  **flag it**. Ask before deviating from a security rule.

## Building on top of this starter

When you add a new feature (a new entity, a new lane, a new integration), follow
the phased method and the copy-paste patterns in the skill:

- `.claude/skills/vibe-coding-with-confidence/references/supabase.md` — data-model
  + RLS + realtime + storage patterns.
- `.claude/skills/vibe-coding-with-confidence/references/security.md` — the
  non-negotiables and the Definition of Done.
- `.claude/skills/vibe-coding-with-confidence/references/railway.md` — deploy.

Want the app to **build its own features** — anyone files an idea, an admin
approves, an AI coding agent opens a PR, and a merge deploys? That whole
"idea → shipped code" pipeline is the **`ai-feature-pipeline`** skill
(`.claude/skills/ai-feature-pipeline/`): concept + security model + the GitHub
flow + a build-spec adapted to this starter, with the real production source as
reference. It's a capstone (needs real accounts, an admin role, and merge-deploys).

New user-data table? Copy the `documents` migration shape: `user_id` default
`auth.uid()`, RLS ON, four owner-gated policies, `updated_at` trigger, add to the
realtime publication if the UI should live-update.

## Definition of done (check before calling a feature finished)

- [ ] RLS verified: an incognito window / a second user **cannot** see my data
      (table **and** Storage).
- [ ] No secrets in the client bundle or in git (`service_role` is server-only).
- [ ] Works across two tabs (realtime sync).
- [ ] `npm run typecheck && npm run lint && npm test && npm run build` are green.
- [ ] Deploys clean on Railway over HTTPS.
