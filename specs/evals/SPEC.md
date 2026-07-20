# AI Quality — Technical Handoff (prompt versioning + evals)

*A self-contained porting guide to rebuild the **AI Quality** system into another
Supabase-vibe-coding app (e.g. `alnutile/supabse-vibecoding-starter`). It assumes
the template already ships `prompts` + `skills` + `is_admin()` + `feature_flags` +
the `ai-assist` edge function; if it doesn't, §2 includes all of that too.*

*Companion docs (design + behavior): `specs/evals/SPEC.md`, `specs/evals/DESIGN.md`.
Canonical source in this repo: the migration `supabase/migrations/20260717220000_ai_quality_evals.sql`,
the edge fns `supabase/functions/{run-eval,ask}/index.ts`, the UI
`src/components/admin/AiQualityAdmin.tsx`, the pure logic `src/lib/evals.ts`, and the
MCP tools in `supabase/functions/mcp/index.ts`.*

---

## 1. Mental model (what you're building)

> **Change how an AI area behaves → prove it against real tests → ship it, or hold it — no developer.**

- Every **AI area** has **one prompt**, found by a stable `key` (`ask`, `audience_description`, …).
- A prompt has **versions**. A version is `draft` | `live` | `archived`. **Exactly one `live` per prompt.**
- A version **cannot go live until its evals pass** (promote gate).
- **Evals** = **cases** (an `input` + the `expected` outcome). Running a **suite** against **one version**
  produces a **run** + one **result** per case (produced output, pass/fail, score, judge notes).
- **Promote** = make a passing version `live` — archives the old live and **mirrors the body into
  `prompts.body`** so existing key-based consumers keep working unchanged.
- **`ask_questions`** = customer-facing example chips, each **proven by a case**; only `live` rows are
  shown to customers.
- Same machine for every surface: Ask, descriptions, and whatever comes next all get
  **versions + evals + results + promote**.

```
prompts (parent, keyed)
  ├─ prompt_versions   v1·v2·v3…    draft / live / archived   (exactly one live)
  └─ eval_suites  ── eval_cases  (input → expected, kind: core|guardrail)
       run(suite, version)  ─►  eval_runs  ─►  eval_results (per case)
  promote(version) ─► gate: latest run passed ALL cases (or override w/ reason)
                      ─► archive old live, set live, prompts.body := version.body
ask_questions (chips) ─► reference the eval_case that proved them; live = public
```

---

## 2. Prerequisites (what AI Quality builds ON)

If the template already has these, skip. If not, create them first — AI Quality depends on all of them.

### 2a. `is_admin()` — admin gate by email domain
```sql
create table if not exists public.admin_domains (domain text primary key);
insert into public.admin_domains(domain) values ('yourcompany.com') on conflict do nothing;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_domains d
    where lower(split_part(coalesce(auth.email(),''),'@',2)) = lower(d.domain)
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
```

### 2b. `set_updated_at()` — shared trigger fn (used by prompt_versions)
```sql
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
```

### 2c. `prompts` + `skills` (the foundation the evals version)
```sql
create table if not exists public.prompts (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9][a-z0-9_]*$'),
  label text not null,
  goal  text not null default '',   -- optional north-star line
  body  text not null default '',   -- the LIVE prompt (mirror of the live version)
  is_global boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.skills (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9][a-z0-9_]*$'),
  name text not null, description text not null default '',
  instructions text not null default '',
  is_active boolean not null default true, is_global boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create trigger prompts_set_updated_at before update on public.prompts
  for each row execute function public.set_updated_at();
create trigger skills_set_updated_at before update on public.skills
  for each row execute function public.set_updated_at();
-- RLS: admin-only read+write; automations use service_role (bypasses RLS).
alter table public.prompts enable row level security;
alter table public.skills  enable row level security;
grant select,insert,update,delete on public.prompts to authenticated;
grant select,insert,update,delete on public.skills  to authenticated;
create policy "Admins read prompts"   on public.prompts for select using (public.is_admin());
create policy "Admins manage prompts" on public.prompts for all using (public.is_admin()) with check (public.is_admin());
create policy "Admins read skills"    on public.skills  for select using (public.is_admin());
create policy "Admins manage skills"  on public.skills  for all using (public.is_admin()) with check (public.is_admin());
```
> **prompts vs skills.** A *prompt* is the instruction a specific AI surface runs under a fixed `key`.
> A *skill* is a reusable "how we do X" procedure. AI Quality versions **prompts**. (In this repo the
> description AI-rewrite still reads a `skill`; the clean design is to read the live *prompt* — see §8/§10.)

### 2d. `feature_flags` (+ targets) + `enabled_feature_flags()` RPC
Standard flag table with a per-email `feature_flag_targets` and an RPC that returns the keys ON for the
caller (global-on OR their email targeted), granted to `anon`+`authenticated`. AI Quality ships **dark**
behind an `ai_quality` flag. (If the template lacks flags, you can hardcode the nav item instead.)

### 2e. `ai-assist` edge-function scaffold (the reusable server pattern)
Every AI call stays server-side (the API key never reaches the browser). The reusable scaffold — **copy
this shape for `run-eval`**:
```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const cors = { 'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS' }
const json = (b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}})
Deno.serve(async (req) => {
  if (req.method==='OPTIONS') return new Response('ok',{headers:cors})
  const SUPABASE_URL=Deno.env.get('SUPABASE_URL')!, ANON=Deno.env.get('SUPABASE_ANON_KEY')!
  const KEY=Deno.env.get('ANTHROPIC_API_KEY')
  const auth=req.headers.get('Authorization')??''
  // Admin check with the CALLER's OWN token (RLS still applies for writes):
  const asCaller=createClient(SUPABASE_URL,ANON,{global:{headers:{Authorization:auth}}})
  const { data:u }=await asCaller.auth.getUser(); if(!u?.user) return json({error:'Not authenticated'},401)
  const { data:isAdmin }=await asCaller.rpc('is_admin'); if(!isAdmin) return json({error:'Admins only'},403)
  // … call Anthropic, write with asCaller …
})
```
Anthropic call shape (model ids current as of this writing — **see §10 gotchas**):
```ts
await fetch('https://api.anthropic.com/v1/messages',{ method:'POST',
  headers:{'x-api-key':KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
  body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:500, system, messages:[{role:'user',content:user}] })})
// response text = data.content.filter(b=>b.type==='text').map(b=>b.text).join('')
```

---

## 3. The core schema (the whole system)

Full DDL. Ship it as one migration. **Make triggers/policies drop-first** so the file re-applies cleanly
(matters if you apply manually AND via `supabase db push` — see §10).

```sql
-- 1) prompt_versions — history; exactly one live per prompt ------------------
create table if not exists public.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  prompt_id uuid not null references public.prompts(id) on delete cascade,
  version int not null check (version >= 1),
  body text not null default '',
  model text,                                   -- optional model override (enables A/B later)
  status text not null default 'draft' check (status in ('draft','live','archived')),
  notes text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (prompt_id, version)
);
create index if not exists prompt_versions_prompt_idx on public.prompt_versions (prompt_id);
create unique index if not exists prompt_versions_one_live
  on public.prompt_versions (prompt_id) where (status = 'live');   -- <= the "one live" invariant

-- 2) eval_suites — a named set of cases for a prompt -------------------------
create table if not exists public.eval_suites (
  id uuid primary key default gen_random_uuid(),
  prompt_id uuid not null references public.prompts(id) on delete cascade,
  name text not null default 'Default suite',
  description text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists eval_suites_prompt_idx on public.eval_suites (prompt_id);

-- 3) eval_cases — one test: input + expected. kind = core | guardrail --------
create table if not exists public.eval_cases (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.eval_suites(id) on delete cascade,
  name text not null default '',
  input text not null,
  expected text not null,
  kind text not null default 'core' check (kind in ('core','guardrail')),
  weight numeric not null default 1,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists eval_cases_suite_idx on public.eval_cases (suite_id);

-- 4) eval_runs — one execution of a suite against a VERSION ------------------
create table if not exists public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.eval_suites(id) on delete cascade,
  prompt_version_id uuid not null references public.prompt_versions(id) on delete cascade,
  status text not null default 'running' check (status in ('running','done','failed')),
  total int, passed int, score numeric,          -- score = 0..100
  run_by uuid references auth.users(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists eval_runs_version_idx on public.eval_runs (prompt_version_id, started_at desc);

-- 5) eval_results — per-case outcome within a run ---------------------------
create table if not exists public.eval_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.eval_runs(id) on delete cascade,
  case_id uuid references public.eval_cases(id) on delete set null,
  output text not null default '',
  passed boolean, score numeric,                 -- score = 0..1 per case
  judge_notes text not null default ''
);
create index if not exists eval_results_run_idx on public.eval_results (run_id);

-- 6) ask_questions — customer-facing chips, eval-proven, per prompt ----------
create table if not exists public.ask_questions (
  id uuid primary key default gen_random_uuid(),
  prompt_id uuid references public.prompts(id) on delete cascade,
  question text not null,
  status text not null default 'draft' check (status in ('draft','live','archived')),
  eval_case_id uuid references public.eval_cases(id) on delete set null,
  position int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists ask_questions_prompt_idx on public.ask_questions (prompt_id);
create index if not exists ask_questions_live_idx on public.ask_questions (status) where (status='live');

drop trigger if exists prompt_versions_set_updated_at on public.prompt_versions;
create trigger prompt_versions_set_updated_at before update on public.prompt_versions
  for each row execute function public.set_updated_at();

-- RLS: workbench tables are admin-only. ask_questions live rows are PUBLIC. ---
alter table public.prompt_versions enable row level security;
alter table public.eval_suites enable row level security;
alter table public.eval_cases  enable row level security;
alter table public.eval_runs   enable row level security;
alter table public.eval_results enable row level security;
alter table public.ask_questions enable row level security;
grant select,insert,update,delete on public.prompt_versions to authenticated;
grant select,insert,update,delete on public.eval_suites to authenticated;
grant select,insert,update,delete on public.eval_cases  to authenticated;
grant select,insert,update,delete on public.eval_runs   to authenticated;
grant select,insert,update,delete on public.eval_results to authenticated;
grant select,insert,update,delete on public.ask_questions to authenticated;
grant select on public.ask_questions to anon;   -- public directory reads live chips

-- (drop policy if exists … before each, then:)
create policy "Admins read prompt_versions"   on public.prompt_versions for select using (public.is_admin());
create policy "Admins manage prompt_versions" on public.prompt_versions for all using (public.is_admin()) with check (public.is_admin());
-- …repeat the same read+manage pair for eval_suites / eval_cases / eval_runs / eval_results …
create policy "Public reads live ask_questions" on public.ask_questions for select
  using (status = 'live' or public.is_admin());
create policy "Admins manage ask_questions" on public.ask_questions for all
  using (public.is_admin()) with check (public.is_admin());
```

### The promote gate (the heart) — SECURITY DEFINER RPC
```sql
create or replace function public.promote_prompt_version(
  p_version_id uuid, p_override_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_prompt_id uuid; v_body text; v_status text;
  v_total int; v_passed int; v_green boolean;
  v_reason text := nullif(btrim(coalesce(p_override_reason,'')),'');
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select prompt_id, body, status into v_prompt_id, v_body, v_status
    from public.prompt_versions where id = p_version_id;
  if v_prompt_id is null then raise exception 'Version not found'; end if;
  if v_status = 'live' then return; end if;

  select total, passed into v_total, v_passed         -- latest completed run
    from public.eval_runs where prompt_version_id = p_version_id and status='done'
    order by started_at desc limit 1;
  v_green := (v_total is not null and v_total > 0 and v_passed = v_total);

  if not v_green and v_reason is null then
    raise exception 'Evals are not green for this version — run the suite and pass all cases, or promote with an override reason.';
  end if;

  update public.prompt_versions set status='archived' where prompt_id=v_prompt_id and status='live';
  update public.prompt_versions set status='live',
      notes = case when v_reason is null then notes
                   else btrim(notes || E'\n[promoted with override] ' || v_reason) end
    where id = p_version_id;
  update public.prompts set body = v_body, updated_at = now() where id = v_prompt_id;  -- MIRROR
end $$;
revoke all on function public.promote_prompt_version(uuid,text) from public;
grant execute on function public.promote_prompt_version(uuid,text) to authenticated;
```
**Gate rule:** promotable only if the latest `done` run passed **every** case (`passed = total`), else an
explicit `override_reason` (logged in `notes`). Tune "all pass" → "≥ threshold" here if you want.

---

## 4. The run engine (`run-eval` edge function)

Admin-gated Deno function. Input `{ suite_id, prompt_version_id }`. For each case it **produces** then
**judges**, writes an `eval_run` (`done`) + one `eval_result` per case, returns the summary. Copy the
§2e scaffold, then:

1. Load the version (`body`,`model`) + all `eval_cases` in the suite (admin reads via `asCaller`).
2. **Produce** per case: `Claude(system = version.body, user = case.input)` → `output`.
3. **Judge** per case: `Claude(system = JUDGE_RUBRIC, user = "INPUT…EXPECTED…ANSWER…")` → JSON
   `{passed, score, notes}`. The rubric explicitly handles **guardrail** cases (EXPECTED describes a
   refusal → pass only if the answer actually refuses).
4. Bounded concurrency (`pool(cases, 6, gradeCase)`), cap the suite (e.g. 40) so it fits the function's
   wall-clock. Default model `claude-haiku-4-5-20251001` (fast; pass through `version.model` if it names a
   real model).
5. Roll up `passed/total/score`, insert `eval_runs` (done) + `eval_results` with `asCaller` (RLS: admin).

Judge rubric (verbatim, the key part):
```
You grade an AI answer. Given INPUT, EXPECTED (team-written), and ANSWER, decide if the answer
satisfies EXPECTED. If EXPECTED describes a refusal/fallback, PASS only if the answer actually
refuses/falls back that way. Otherwise PASS if it meets the expected outcome without fabricating.
Return ONLY JSON: {"passed": true|false, "score": 0.0-1.0, "notes": "one short sentence"}.
```
> **Proxy caveat (important).** This generic runner runs the prompt as a plain chat. That's a **faithful**
> proxy for surfaces whose real job *is* generate-from-input (e.g. **descriptions**). It is a **weak**
> proxy for surfaces that do retrieval/tools before the LLM (e.g. **Ask**, which parses → queries a catalog
> → composes) — the chat has no catalog so it may hedge or fabricate and under-score. The clean upgrade is
> to have `run-eval` invoke the surface's **real pipeline** for that prompt key, not a chat. Ship the
> generic runner first; special-case per surface later. Guardrail (refusal) cases are meaningful either way.

---

## 5. The admin UI — the "AI Quality" workbench

One admin section. Full visual spec in `specs/evals/DESIGN.md`; structure to rebuild:

- **Home** — cards, one per prompt that has ≥1 version: label, `Live v3` / `Draft v4 ⚠`, and a **score chip**
  from the live version's latest run (`92% · 46/50 ✓` green, `3 failing` red, `⚠ untested` amber, `—`).
- **Detail** (per prompt) — 4 tabs:
  - **Versions**: a left rail (each version: status pill + `vN` + latest-run chip + timestamp; **New draft**
    clones live) and a right **editor** (body textarea + model select; **only a draft is editable**; live/
    archived are read-only). Below: the **promote bar** — green run → **Promote to Live**; not green →
    disabled + **Override…** (reason modal). Buttons: **Save draft**, **Run evals ▸**.
  - **Cases**: Core / Guardrail groups; add / edit / delete inline; (Generate / Import are stubs).
  - **Results**: run summary (`46/50 · 92% · v4`), a per-case table (✓/✗, input, expected, produced output
    expandable, judge notes; failing first), and **compare versions** (pick another version's run → side-by-side
    verdict columns; a case that passed on the old and fails on the new is flagged **regressed** red).
  - **Ask questions**: the chips manager — status pill + proof line + Publish/Unpublish. **Publish only when
    the linked case is core AND passes** (guardrail-linked → "Blocked — its case expects a refusal";
    no case → "Needs case").

**Data flow:** all reads/writes go straight through the supabase client (RLS = admin-only). "Run evals" calls
`supabase.functions.invoke('run-eval', { body:{ suite_id, prompt_version_id } })`. "Promote" calls
`supabase.rpc('promote_prompt_version', { p_version_id, p_override_reason })` and surfaces the gate error to
open the override path. Per-version score = its latest `status='done'` run.

**Pure, testable logic — copy `src/lib/evals.ts` verbatim** (it's the gate/score/publish rules, unit-tested):
```ts
export function isVersionGreen(run){ return !!run && run.total!=null && run.total>0 && run.passed===run.total }
export function scoreChip(run, status){ /* → {label, tone: green|amber|red|none} */ }
export function questionPublishState({status, hasCase, guardCase}){
  if (status!=='draft') return {canPublish:false, blocked:false, reason:'not-draft'}
  if (!hasCase)         return {canPublish:false, blocked:true,  reason:'no-case'}
  if (guardCase)        return {canPublish:false, blocked:true,  reason:'guardrail'}
  return {canPublish:true, blocked:false, reason:'ok'}
}
```

**Wiring:** add a nav item (dark behind the `ai_quality` flag) to your admin shell, a route
(`/admin/ai-quality` → `<AiQualityAdmin/>`), and reuse the shell's design tokens
(indigo `#4f46e5`; status green `#3f8f5f`/`#e9f5ee`, amber `#b7791f`/`#fbf3df`, red `#c0392b`/`#fdecea`,
slate `#5a6b7b`).

---

## 6. MCP tools (optional — run/see/do from a connected Claude)

12 tools added to the app's MCP server (each uses the caller's admin JWT → RLS applies):
`list_prompt_versions` · `get_prompt_version` · `new_prompt_draft` · `update_prompt_version` ·
`list_eval_cases` · `add_eval_case` · **`run_eval`** · `list_eval_runs` · `get_eval_run` ·
**`promote_prompt_version`** · `list_ask_questions` · `set_ask_question_status`.

- **`run_eval` delegates** to the deployed `run-eval` function (one source of truth for the run logic +
  the API key) by `fetch`-ing `${SUPABASE_URL}/functions/v1/run-eval` with the caller's bearer token.
- Add helper resolvers `resolvePromptId({prompt_id|key})` and `resolveSuiteId(...)` so tools accept a
  friendly prompt `key` (e.g. `"ask"`).

---

## 7. Consumers — how an AI feature uses the system

A consumer is just an edge function that **reads the live prompt by key and runs it**:
```ts
const { data } = await db.from('prompts').select('body').eq('key','ask').maybeSingle()
const system = data.body  // == the LIVE version's body (promote keeps it mirrored)
```
Two live consumers in this repo:
- **Ask** (`supabase/functions/ask`): `parse (LLM, live `ask` prompt) → retrieve (SQL over the published
  catalog) → group by type → compose`. Structured-first, so it can only return real rows. Its chips come
  from `ask_questions` (live). Public/anon-callable (reads via service_role).
- **Descriptions** (`audience_description` prompt): generate-from-facts. The eval runner is a faithful proxy
  here (see §4), so its evals actually mean something. (Wiring the "AI rewrite" button at this prompt instead
  of the older `audience_description` *skill* is the last mile — §10.)

**Promote → the consumer updates automatically** because it reads `prompts.body`, which promotion rewrites.

---

## 8. Seed strategy

Seed inside an idempotent `do $$ … $$` block guarded by `if exists (select 1 from prompt_versions where prompt_id=…) then return; end if;`. Per AI area seed: the `prompts` row (on conflict do nothing), 2–3
`prompt_versions` (v1 archived, v2 live = `prompts.body`, v3 draft), one `eval_suite`, a spread of
`eval_cases` (core + a few **guardrail** refusal cases), a **green baseline run** on the live version (so the
home card shows a score immediately), and any `ask_questions` (mix of live/draft; link some to their proving
case via a `(select id from eval_cases where name='…')` subquery).

---

## 9. Ship checklist (port order)

1. **Prereqs (§2)** exist: `is_admin()`, `set_updated_at()`, `prompts`, `skills`, feature flags, the
   `ai-assist` scaffold, `ANTHROPIC_API_KEY` secret.
2. **Migration**: §3 schema + promote RPC + `ai_quality` flag seed + §8 seed. Drop-first triggers/policies.
   Apply; verify one-live-per-prompt.
3. **`run-eval`** edge fn (§4). Deploy. Add its deploy step to your functions workflow.
4. **`AiQualityAdmin` UI** (§5) + `lib/evals.ts` (+ tests) + nav item + route + `ai_quality` flag (dark).
5. **(optional) MCP tools** (§6) + **consumer(s)** (§7).
6. Gate: `typecheck && lint && test && build` green; migration applies via CI.

---

## 10. Gotchas & lessons (learned building this)

- **`temperature` is DEPRECATED on `claude-sonnet-5`** — sending it → **HTTP 400**, the whole call fails
  silently to the user. Don't pass `temperature` to sonnet-5. (Haiku/opus tolerate omission; just omit it.)
- **Model ids** used here: `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` (runner default),
  `claude-fable-5`. Verify against the current API before shipping.
- **Eval-as-proxy** (§4): generic runner is faithful for generate-from-input surfaces (descriptions), weak for
  retrieval surfaces (Ask). Don't over-trust an Ask eval score until the runner invokes the real pipeline;
  guardrail cases are trustworthy regardless. Our first **clean green promote** was a *description* draft; the
  Ask draft only shipped via override for exactly this reason.
- **Idempotent migrations**: if you ever apply a migration manually (psql) *and* also let CI `supabase db push`,
  the CLI re-applies it (it isn't in the CLI's history table) → `create trigger/policy` collide. Use
  `drop … if exists` before every trigger/policy and `create … if not exists` for tables/indexes.
- **Anon can't scope by prompt on the public chip query.** The directory reads `ask_questions where status='live'`
  and **cannot** join to admin-only `prompts` — so don't filter the customer chip query by prompt client-side;
  `status='live'` is the correct public-safe query.
- **Promote mirrors `prompts.body`** on purpose — it's the seam that lets existing key-based consumers keep
  working with zero changes. Keep it.
- **One live per prompt** is enforced by a partial unique index, not app logic — trust it.
- **RLS lets the run engine write with the caller's admin token** (no service_role needed for run-eval); only
  public-facing consumers (Ask) use service_role to read the live prompt + published data.
```
