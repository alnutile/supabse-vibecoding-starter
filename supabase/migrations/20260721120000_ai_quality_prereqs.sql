-- AI Quality — prerequisites (§2 of specs/evals/SPEC.md), adapted for this
-- starter. Builds the foundation the evals system depends on:
--   • is_admin()  — admin gate, backed by Supabase's own auth.users metadata
--   • prompts     — one keyed prompt per AI surface (body = the LIVE prompt)
--   • skills      — reusable "how we do X" procedures (versioned later, if ever)
--
-- set_updated_at() already exists (see the documents migration); we reuse it.

-- 1) is_admin() -------------------------------------------------------------
-- Admin is NOT a domain wildcard. It reads `is_admin` from the caller's
-- app_metadata (auth.users.raw_app_meta_data), which ONLY the service_role /
-- Admin API can write — a user can never escalate themselves. Make yourself an
-- admin once, server-side:
--   update auth.users
--      set raw_app_meta_data = raw_app_meta_data || '{"is_admin": true}'::jsonb
--    where email = 'you@example.com';
-- (or via the Admin API: supabase.auth.admin.updateUserById(id, { app_metadata: { is_admin: true } })).
-- The user must obtain a fresh token (re-login / refresh) for a JWT-based read,
-- but this function reads auth.users directly so it's correct immediately.
create or replace function public.is_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select coalesce(
    (select (u.raw_app_meta_data ->> 'is_admin')::boolean
       from auth.users u
      where u.id = auth.uid()),
    false
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 2) prompts — the instruction a specific AI surface runs under a fixed key.
-- `body` is the LIVE prompt: promotion mirrors the live version's body here so
-- key-based consumers keep working unchanged.
create table if not exists public.prompts (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9][a-z0-9_]*$'),
  label text not null,
  goal text not null default '',       -- optional north-star line
  body text not null default '',       -- the LIVE prompt (mirror of the live version)
  is_global boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) skills — a reusable procedure. AI Quality versions prompts, not skills;
-- this table exists so the foundation matches the spec and future surfaces have
-- a home for shared "how we do X" text.
create table if not exists public.skills (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9][a-z0-9_]*$'),
  name text not null,
  description text not null default '',
  instructions text not null default '',
  is_active boolean not null default true,
  is_global boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists prompts_set_updated_at on public.prompts;
create trigger prompts_set_updated_at
  before update on public.prompts
  for each row execute function public.set_updated_at();

drop trigger if exists skills_set_updated_at on public.skills;
create trigger skills_set_updated_at
  before update on public.skills
  for each row execute function public.set_updated_at();

-- RLS: admin-only read + write. Automations (edge fns) use the caller's admin
-- JWT, so RLS still applies; only public-facing consumers use service_role.
alter table public.prompts enable row level security;
alter table public.skills  enable row level security;
grant select, insert, update, delete on public.prompts to authenticated;
grant select, insert, update, delete on public.skills  to authenticated;

drop policy if exists "Admins read prompts"   on public.prompts;
drop policy if exists "Admins manage prompts" on public.prompts;
create policy "Admins read prompts"   on public.prompts for select using (public.is_admin());
create policy "Admins manage prompts" on public.prompts for all   using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read skills"   on public.skills;
drop policy if exists "Admins manage skills" on public.skills;
create policy "Admins read skills"    on public.skills for select using (public.is_admin());
create policy "Admins manage skills"  on public.skills for all   using (public.is_admin()) with check (public.is_admin());
