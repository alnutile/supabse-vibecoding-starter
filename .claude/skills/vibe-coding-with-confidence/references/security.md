# Security — the non-negotiable core

These rules apply to **every** app built with this skill. They are the part you
keep even when you swap the framework, the host, or the database. When a security
choice is unclear, pick the **safer** option and **flag it** — never guess quietly.

## Start here, every time

- **Nothing is unhackable.** Risk scales with complexity, so keep each step as
  simple as it can be. A static file is safe; a multi-user app needs care. Add
  protection as you add capability, not before and not after.
- **Obscurity is never security.** Never rely on a hard-to-guess URL, a hidden
  route, or a client-side check as the thing that keeps data private. The
  database must enforce access, not the UI.

## Auth

- **Never roll your own auth.** Use a proven provider (Supabase Auth by default).
  No hand-built password hashing, no custom session tokens, no home-grown JWT.
- **Two phases, on purpose:**
  1. *Anonymous auth* — a session with no login UI, so you can build the core
     fast against real per-user rows.
  2. *Real accounts* — open sign-up, magic links, no separate email-verification
     step (tighten later, even invite-only, if you want). When you move to real
     accounts, **remove the anonymous auth** to keep it simple.

## Row Level Security (RLS)

- **RLS is ON for every table that holds user data.** No exceptions — turn it on
  from the very first row, even during the anonymous-auth phase.
- **Default-deny, then add policies.** With RLS enabled and no policy, everything
  is denied. Add explicit policies for **select / insert / update / delete**, all
  gated on ownership (`user_id = auth.uid()`).
- **Verify, don't assume.** After any auth or schema change, confirm a second user
  / an incognito window genuinely cannot see the first user's rows.

## Env var & secret discipline

- **Only `VITE_`-prefixed values reach the browser — treat them as PUBLIC.**
  Anything a bundler ships to the client is visible to users. Never put a secret
  behind a `VITE_` var.
- **The anon / publishable key is fine client-side.** It is designed to be public
  and is safe in a `VITE_` var.
- **The `service_role` key is server-only.** It **bypasses RLS**. Never in client
  code, never in a `VITE_` var, never committed. It lives only in a server
  process's environment (e.g. a Railway service variable).
- **`.env` is gitignored.** Ship a `.env.example` with **placeholder** values
  only — never real keys.
- When a server process uses `service_role` (it bypasses RLS), it **must set the
  owner column explicitly** on every row it writes — the database is no longer
  enforcing ownership for that caller.

## Transport

- **HTTPS only.** Railway (and most modern hosts) give it to you for free — don't
  undo it. If your host doesn't default to HTTPS, put it in place before shipping.
- A CDN/proxy in front (e.g. Cloudflare's orange-cloud) adds baseline hardening —
  hides the origin, free edge TLS, DDoS absorption, bot filtering — but it is a
  **layer in front of** real auth + RLS, never a replacement for them.

## Keep a component's dependencies in the component

- A separate service (like a sync agent) keeps its **own** `package.json` and
  dependencies in its **own** folder. Don't let its install leak deps into the web
  app — that breaks the web app's build and blurs the security boundary.
- Pin the host's Node version (`engines` in `package.json` + `.nvmrc`) so a
  deploy doesn't silently build on an old runtime.

## Definition of Done — verify before calling a feature finished

- [ ] **RLS verified:** an incognito window / a second user **cannot** see my data.
- [ ] **No secrets in the client bundle or in git** — `service_role` is server-only.
- [ ] **Works across two tabs** (realtime sync).
- [ ] **Deploys clean over HTTPS.**
