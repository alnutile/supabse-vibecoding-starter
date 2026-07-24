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

-- Keep updated_at fresh on every write (mirrors the documents table trigger).
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists features_set_updated_at on public.features;
create trigger features_set_updated_at
  before update on public.features
  for each row execute function public.set_updated_at();

-- Live board: PR links land asynchronously via the edge function's sync; without
-- realtime they'd only show after a manual reload.
alter publication supabase_realtime add table public.features;
