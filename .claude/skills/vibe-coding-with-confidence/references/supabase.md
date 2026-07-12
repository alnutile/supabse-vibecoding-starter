# Supabase patterns (copy-paste, generalized)

Every pattern below comes from a working build. Replace `items` / `item_status`
with your domain table and states; the **shape** stays the same for any app.

## Data-model rules (any user-owned table)

Minimum columns for a table that holds per-user data:

| column       | notes                                                         |
|--------------|---------------------------------------------------------------|
| `id`         | uuid, primary key, default `gen_random_uuid()`                |
| `user_id`    | uuid, **not null**, default `auth.uid()`, FK → `auth.users`   |
| `...domain`  | your fields (title/name, notes, amount, status enum, …)       |
| `position`   | ordering within a group, if you sort/drag (int or float)      |
| `created_at` | timestamptz, default `now()`                                  |
| `updated_at` | timestamptz, kept fresh by a trigger                          |

- Give `user_id` a default of `auth.uid()` and an `on delete cascade` FK so a
  user's rows vanish with their account.
- Use a Postgres `enum` for a fixed set of states (lanes, categories, stages).

## Table + RLS + realtime (one migration)

```sql
-- A fixed set of states (rename to your domain: stages, categories, lanes…).
create type public.item_status as enum ('backlog', 'next', 'in_progress', 'done');

create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) > 0),
  notes text,
  status public.item_status not null default 'backlog',
  position double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index items_user_status_position_idx
  on public.items (user_id, status, position);

-- Default-deny: RLS ON, then per-user policies. Holds even at the anonymous stage.
alter table public.items enable row level security;

create policy "Users select own items"
  on public.items for select using (auth.uid() = user_id);

create policy "Users insert own items"
  on public.items for insert with check (auth.uid() = user_id);

create policy "Users update own items"
  on public.items for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users delete own items"
  on public.items for delete using (auth.uid() = user_id);

-- Keep updated_at fresh on every change.
create or replace function public.set_updated_at()
  returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger items_set_updated_at
  before update on public.items
  for each row execute function public.set_updated_at();

-- Realtime over websockets. REPLICA IDENTITY FULL so DELETE payloads carry the
-- old row (incl. user_id) for the client-side filter.
alter table public.items replica identity full;
alter publication supabase_realtime add table public.items;
```

Four policies (select/insert/update/delete), all gated on `auth.uid() = user_id`
— that is the whole RLS story for a single-owner table.

## Client setup (public keys only)

```ts
import { createClient } from '@supabase/supabase-js'

// Both values are PUBLIC and safe in VITE_ vars. Never the service_role key.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)
```

## Auth: phase 2 (anonymous) → phase 3 (real accounts)

**Anonymous** — a session with no login UI, so you can build against real rows:

```ts
const { data: { session } } = await supabase.auth.getSession()
if (!session) await supabase.auth.signInAnonymously()
```

**Real accounts** — open sign-up, password **and** magic link, no email
verification. Then **remove the anonymous sign-in** call.

```ts
// Password
await supabase.auth.signUp({ email, password })
await supabase.auth.signInWithPassword({ email, password })
// Magic link — redirect origin MUST be in Supabase's Redirect URLs allowlist
await supabase.auth.signInWithOtp({
  email,
  options: { emailRedirectTo: window.location.origin },
})
await supabase.auth.signOut()
```

**Dashboard settings (no code):**
- *Authentication → Sign In / Providers*: Email **on**, "Confirm email" **OFF**
  (magic links work once Email is on), "Allow anonymous sign-ins" **OFF** at
  phase 3.
- *Authentication → URL Configuration*: set **Site URL** to production, and add
  **both** dev and prod origins to **Redirect URLs** (e.g. `http://localhost:5173/**`
  and `https://<app>.up.railway.app/**`) or magic links break in one environment.

## Realtime (converge across tabs)

Optimistic UI is fine, but reconcile from the realtime event so tabs converge.

```ts
const channel = supabase
  .channel('items')
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'items', filter: `user_id=eq.${userId}` },
    (payload) => { /* reconcile local state from payload.new / payload.old */ })
  .subscribe()
// later: supabase.removeChannel(channel)
```

## Server-side upsert without duplicates (for a sync agent)

When an agent re-runs, upsert on a stable external id instead of inserting. A
partial unique index keeps existing rows (with `NULL external_id`) unaffected;
a `SECURITY INVOKER` function granted only to `service_role` does the ON CONFLICT
against the partial index (PostgREST's `.upsert()` can't infer a partial index).

```sql
alter table public.items add column external_id text;

create unique index items_user_external_id_key
  on public.items (user_id, external_id)
  where external_id is not null;

create or replace function public.sync_external_items(p_user_id uuid, p_rows jsonb)
returns integer language plpgsql set search_path = '' as $$
declare affected integer := 0;
begin
  insert into public.items (user_id, external_id, title, status)
  select p_user_id, elem->>'external_id', elem->>'title',
         (elem->>'status')::public.item_status
  from jsonb_array_elements(p_rows) as elem
  where coalesce(elem->>'external_id','') <> '' and coalesce(elem->>'title','') <> ''
  on conflict (user_id, external_id) where external_id is not null
  do update set title = excluded.title, status = excluded.status, updated_at = now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Only the server-side service_role may call it; RLS still blocks everyone else.
revoke execute on function public.sync_external_items(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sync_external_items(uuid, jsonb) to service_role;
```

## Applying migrations

Keep SQL in `supabase/migrations/` and apply on push via CI (`supabase db push`
only runs versions the project hasn't recorded, so re-runs are safe). CI needs
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` as repo secrets; the project
ref is public.
