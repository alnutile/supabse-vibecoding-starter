-- Minimal roles: one profiles row per user, first signup is the admin.
-- The Features pipeline needs a trust boundary for "approve" (spends AI $ / opens
-- a public issue) and "merge" (ships to prod). If you already have roles, use them.
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

-- Backfill: any users that already exist (before this migration) get a profile,
-- and the earliest one becomes admin if none is set yet.
insert into public.profiles (id, email, is_admin)
select u.id, u.email, false
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
order by u.created_at;

update public.profiles
set is_admin = true
where id = (select id from public.profiles order by created_at asc limit 1)
  and not exists (select 1 from public.profiles where is_admin);
