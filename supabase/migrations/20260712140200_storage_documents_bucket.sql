-- A PRIVATE bucket for uploaded files. Private means objects are never served
-- over a public URL — the app hands out short-lived signed URLs instead.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- Per-user Storage permissions. Every object key is "<uid>/<file>", so
-- (storage.foldername(name))[1] is the owner's uid. A user may only touch
-- objects under their own folder — the Storage equivalent of table RLS.
create policy "Users read own files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users upload own files"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users update own files"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users delete own files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
