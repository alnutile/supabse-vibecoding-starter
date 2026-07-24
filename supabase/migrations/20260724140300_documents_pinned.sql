-- Let a user pin a document so it surfaces in its own row at the top of
-- their document list. Owner-scoped by the existing documents RLS policies.
alter table public.documents
  add column if not exists pinned boolean not null default false;
