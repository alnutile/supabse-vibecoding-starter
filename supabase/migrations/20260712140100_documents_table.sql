-- Per-user documents metadata. The file bytes live in Storage (see the next
-- migration); this table holds one row per uploaded file.
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) > 0),
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index documents_user_created_idx
  on public.documents (user_id, created_at desc);

-- Default-deny: RLS ON, then per-user policies. A user only ever touches their
-- own rows.
alter table public.documents enable row level security;

create policy "Users select own documents"
  on public.documents for select
  using (auth.uid() = user_id);

create policy "Users insert own documents"
  on public.documents for insert
  with check (auth.uid() = user_id);

create policy "Users update own documents"
  on public.documents for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users delete own documents"
  on public.documents for delete
  using (auth.uid() = user_id);

-- Keep updated_at fresh on every change.
create or replace function public.set_updated_at()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger documents_set_updated_at
  before update on public.documents
  for each row
  execute function public.set_updated_at();

-- Realtime over websockets. REPLICA IDENTITY FULL so DELETE payloads carry the
-- old row (incl. user_id) for the client-side filter.
alter table public.documents replica identity full;
alter publication supabase_realtime add table public.documents;
