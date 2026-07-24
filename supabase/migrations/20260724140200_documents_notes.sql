-- Redesigned document detail modal shows an editable "Notes" field. Add the
-- column it reads/writes. Nullable, owner-scoped by the existing documents RLS.
alter table public.documents
  add column if not exists notes text;
