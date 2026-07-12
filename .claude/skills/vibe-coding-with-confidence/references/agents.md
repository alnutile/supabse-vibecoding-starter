# Per-user sync agents (Zapier SDK)

The finale: a small agent that syncs from a system you already own (Google Tasks,
etc.) into your app's table, so something you jot on your phone shows up in the
app. The Zapier SDK is the point — it hands you one consistent way to reach
9,000+ apps using connections you've **already authorized**, so you don't build
OAuth/token-refresh plumbing yourself.

## The rule that makes this good

**One agent per user, scoped to that user's access.** Do NOT build a shared
multi-tenant bot. Each person runs their own agent wired to their own connection,
touching only their own account. Your agent reaches *your* stuff, on *your* terms.

## Structure — one folder = one agent = one service

```
agents/
  <source>-sync/        # named by SOURCE system (google-tasks-sync), not destination
    package.json        # its OWN deps — never mixed into the web app
    railway.json        # its own build/start + cron
    tsconfig.json
    .env.example        # placeholders only
    src/index.ts
```

- Named by its **source** — every agent feeds the same table, so the source is
  what distinguishes them.
- **Self-contained.** Its dependencies live in its own folder. Letting an agent's
  install leak deps into the web app breaks the web app's build.
- Deploy as a **second Railway service** with **Root Directory** = the agent's
  folder (see `references/railway.md`).

## Security (server-side, verify)

- The agent talks to Supabase with the **`service_role`** key from a server-only
  env var — never a `VITE_` var, never in the web app, never committed. Add a
  placeholder to `.env.example`.
- `service_role` **bypasses RLS**, so the agent MUST set `user_id` explicitly to
  the target user on every row (from an env var = that account).
- Scope the Zapier credentials to exactly the actions the agent needs.

## Flow (discover, don't guess)

The Zapier SDK is new — do not rely on training-data method names. Discover app
keys, action keys, and input shapes at runtime with the CLI/SDK, then run the
real action:

```bash
npx -p @zapier/zapier-sdk-cli zapier-sdk login
npx -p @zapier/zapier-sdk-cli zapier-sdk list-connections --owner me --json
npx -p @zapier/zapier-sdk-cli zapier-sdk list-actions <appKey>
```

```ts
import { createZapierSdk } from '@zapier/zapier-sdk'
const zapier = createZapierSdk(/* browser login locally, or client credentials on the server */)

// Read from the source using the discovered action + your connection id.
const { data } = await zapier.runAction({
  app: '<appKey>', actionType: 'read', action: '<actionKey>',
  connection: process.env.SOURCE_CONNECTION_ID!,
  inputs: { /* discovered inputs, e.g. show_completed: true */ },
})
```

Map the source records to your domain (e.g. `needsAction → backlog`,
`completed → done`), then upsert **without duplicates** on a stable
`external_id` via the server-side `sync_external_*` function (see
`references/supabase.md`). Add/update only — don't delete rows missing from the
source unless that's explicitly in scope.

For the Zapier SDK's method surface, prefer the bundled README
(`node_modules/@zapier/zapier-sdk/README.md`, version-locked) or the live docs at
https://docs.zapier.com/sdk/reference — this repo also vendors a `zapier-sdk`
skill under `.agents/skills/`.

## Debugging lessons (they will bite)

- **Silent death with no output** → the process is hard-killed or discarding logs
  on exit. Make it log **synchronously and loudly** before you theorize.
- **"Half of it worked" hides denied auth** → listing metadata can succeed while
  the real read is denied. Test the real action early.
- **Under-scoped credentials** → the SDK lets you control exactly what a set of
  credentials may do (good, security-wise); set the scope for the real action.
- **Pin Node** (`engines` + `.nvmrc`) so the host doesn't default to something old.
