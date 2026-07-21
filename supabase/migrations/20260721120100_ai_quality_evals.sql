-- AI Quality — core schema + promote gate (§3 of specs/evals/SPEC.md).
--
--   prompts (parent, keyed)
--     ├─ prompt_versions   v1·v2·v3…   draft / live / archived   (exactly one live)
--     └─ eval_suites ── eval_cases  (input → expected, kind: core|guardrail)
--          run(suite, version) ─► eval_runs ─► eval_results (per case)
--   promote(version) ─► gate: latest run passed ALL cases (or override w/ reason)
--                       ─► archive old live, set live, prompts.body := version.body
--   ask_questions (chips) ─► reference the eval_case that proved them; live = public
--
-- Triggers/policies are DROP-FIRST so this file re-applies cleanly whether it's
-- run manually or via `supabase db push`.

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
-- The "one live per prompt" invariant — enforced by the DB, not app logic.
create unique index if not exists prompt_versions_one_live
  on public.prompt_versions (prompt_id) where (status = 'live');

-- 2) eval_suites — a named set of cases for a prompt ------------------------
create table if not exists public.eval_suites (
  id uuid primary key default gen_random_uuid(),
  prompt_id uuid not null references public.prompts(id) on delete cascade,
  name text not null default 'Default suite',
  description text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists eval_suites_prompt_idx on public.eval_suites (prompt_id);

-- 3) eval_cases — one test: input + expected. kind = core | guardrail -------
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
create index if not exists ask_questions_live_idx on public.ask_questions (status) where (status = 'live');

drop trigger if exists prompt_versions_set_updated_at on public.prompt_versions;
create trigger prompt_versions_set_updated_at
  before update on public.prompt_versions
  for each row execute function public.set_updated_at();

-- RLS: workbench tables are admin-only. ask_questions live rows are PUBLIC. --
alter table public.prompt_versions enable row level security;
alter table public.eval_suites  enable row level security;
alter table public.eval_cases   enable row level security;
alter table public.eval_runs    enable row level security;
alter table public.eval_results enable row level security;
alter table public.ask_questions enable row level security;

grant select, insert, update, delete on public.prompt_versions to authenticated;
grant select, insert, update, delete on public.eval_suites  to authenticated;
grant select, insert, update, delete on public.eval_cases   to authenticated;
grant select, insert, update, delete on public.eval_runs    to authenticated;
grant select, insert, update, delete on public.eval_results to authenticated;
grant select, insert, update, delete on public.ask_questions to authenticated;
grant select on public.ask_questions to anon;   -- public directory reads live chips

drop policy if exists "Admins read prompt_versions"   on public.prompt_versions;
drop policy if exists "Admins manage prompt_versions" on public.prompt_versions;
create policy "Admins read prompt_versions"   on public.prompt_versions for select using (public.is_admin());
create policy "Admins manage prompt_versions" on public.prompt_versions for all   using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read eval_suites"   on public.eval_suites;
drop policy if exists "Admins manage eval_suites" on public.eval_suites;
create policy "Admins read eval_suites"   on public.eval_suites for select using (public.is_admin());
create policy "Admins manage eval_suites" on public.eval_suites for all   using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read eval_cases"   on public.eval_cases;
drop policy if exists "Admins manage eval_cases" on public.eval_cases;
create policy "Admins read eval_cases"   on public.eval_cases for select using (public.is_admin());
create policy "Admins manage eval_cases" on public.eval_cases for all   using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read eval_runs"   on public.eval_runs;
drop policy if exists "Admins manage eval_runs" on public.eval_runs;
create policy "Admins read eval_runs"   on public.eval_runs for select using (public.is_admin());
create policy "Admins manage eval_runs" on public.eval_runs for all   using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read eval_results"   on public.eval_results;
drop policy if exists "Admins manage eval_results" on public.eval_results;
create policy "Admins read eval_results"   on public.eval_results for select using (public.is_admin());
create policy "Admins manage eval_results" on public.eval_results for all   using (public.is_admin()) with check (public.is_admin());

-- ask_questions: live rows are public (the customer chip directory); everything
-- else is admin. Anon CANNOT join to admin-only prompts, so the public query is
-- simply `status = 'live'` — do not filter chips by prompt client-side.
drop policy if exists "Public reads live ask_questions" on public.ask_questions;
drop policy if exists "Admins manage ask_questions"     on public.ask_questions;
create policy "Public reads live ask_questions" on public.ask_questions for select
  using (status = 'live' or public.is_admin());
create policy "Admins manage ask_questions" on public.ask_questions for all
  using (public.is_admin()) with check (public.is_admin());

-- The promote gate (the heart) — SECURITY DEFINER RPC -----------------------
-- Promotable only if the latest `done` run passed EVERY case (passed = total),
-- else an explicit override reason (logged in notes). Promotion archives the old
-- live, sets this version live, and MIRRORS the body into prompts.body so
-- key-based consumers update automatically.
create or replace function public.promote_prompt_version(
  p_version_id uuid,
  p_override_reason text default null
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_prompt_id uuid;
  v_body text;
  v_status text;
  v_total int;
  v_passed int;
  v_green boolean;
  v_reason text := nullif(btrim(coalesce(p_override_reason, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  select prompt_id, body, status into v_prompt_id, v_body, v_status
    from public.prompt_versions where id = p_version_id;
  if v_prompt_id is null then
    raise exception 'Version not found';
  end if;
  if v_status = 'live' then
    return;
  end if;

  -- latest completed run for this version
  select total, passed into v_total, v_passed
    from public.eval_runs
   where prompt_version_id = p_version_id and status = 'done'
   order by started_at desc
   limit 1;
  v_green := (v_total is not null and v_total > 0 and v_passed = v_total);

  if not v_green and v_reason is null then
    raise exception 'Evals are not green for this version — run the suite and pass all cases, or promote with an override reason.';
  end if;

  update public.prompt_versions set status = 'archived'
    where prompt_id = v_prompt_id and status = 'live';
  update public.prompt_versions set status = 'live',
      notes = case when v_reason is null then notes
                   else btrim(notes || E'\n[promoted with override] ' || v_reason) end
    where id = p_version_id;
  update public.prompts set body = v_body, updated_at = now()
    where id = v_prompt_id;   -- MIRROR: keeps key-based consumers working
end $$;
revoke all on function public.promote_prompt_version(uuid, text) from public;
grant execute on function public.promote_prompt_version(uuid, text) to authenticated;
