---
name: vibe-coding-with-confidence
description: >-
  Opinionated guardrails for vibe-coding a new web app from scratch — the
  consistency and security Lovable/Replit bake in, on your own terms. Use when
  starting or scaffolding ANY new application, or when the request involves
  Supabase auth/database/realtime, Row Level Security (RLS), a login/accounts
  flow, deploying to Railway, per-user data, VITE_ env-var / service_role secret
  discipline, or a per-user Zapier SDK sync agent. Triggers: "new app", "start a
  project", "static hello world", "add a database", "add auth", "add login",
  "row level security", "deploy to railway", "sync agent", "vibe code".
---

# Vibe Coding With Confidence

The opinion you bring to a vibe-coded project so the AI builds things
**consistently** and **securely** — written down so you get it on your own terms
instead of relying on what Lovable/Replit bake in.

This skill is **stack- and domain-agnostic**. The to-do board in this repo is the
worked example; the *method and guardrails* below drive any new app (an expense
tracker, a CRM, a bookmark manager — whatever). Change the **defaults**
deliberately; keep the **security rules**.

## The one idea

**Risk scales with complexity.** A static file a browser just renders is nearly
un-attackable. The moment you add logins, a database, and other people's data,
the surface grows — so you add the matching protections (auth + RLS) as you grow,
not all at once. Start simple, stay safe, layer up.

## How to work (defaults, not laws)

1. **Apply the security rules in `references/security.md` by default.** They are
   the non-negotiable core. Read that file before writing auth, database, env, or
   deploy code.
2. **Prefer the simplest thing that is still secure.** Don't build the whole app
   in one shot.
3. **On any security choice you're unsure about, pick the safer option and flag
   it** — don't guess quietly. Ask before deviating from a security rule.
4. **Build in phases.** Each phase ships and is reachable before the next starts.
   See `references/build-phases.md`.

## Default stack

Change these deliberately (per app), but these are the batteries-included picks:

| Concern | Default | Why |
|---|---|---|
| Frontend | Vite + React + TypeScript | Fast; the `VITE_` prefix cleanly marks public env vars |
| DB + auth + realtime | Supabase | RLS, magic-link auth, and websockets in one place |
| Hosting | Railway (deploy from GitHub on push) | Free HTTPS, redeploy on every push |
| Outside integrations | Zapier SDK | 9,000+ apps without building OAuth plumbing |

## The build, phase by phase

Full reusable prompt templates for each phase are in
`references/build-phases.md`. The shape is always:

1. **Static** — a working UI that persists to `localStorage`. No backend, no auth.
   Deploy it to Railway and confirm it's reachable over HTTPS. **Stop.**
2. **Database (anonymous auth)** — swap `localStorage` for Supabase. Model your
   domain table per `references/supabase.md`, **RLS ON from the first row**,
   realtime over websockets. Anonymous auth = a session with no login UI. **Stop.**
3. **Real accounts** — open sign-up, email+password **and** magic links, no email
   verification (tighten later). **Remove anonymous auth.** Gate everything behind
   a session; verify RLS still isolates users. **Stop.**
4. **Design polish** (optional) — a presentation-only pass. Explicitly do **not**
   change functionality (auth gate, RLS, realtime, persistence all keep working).
5. **Per-user agent** (optional finale) — a small, separate server-side service
   that syncs from a system you already own (e.g. Google Tasks) into your table.
   One agent per user, scoped to that user. See `references/agents.md`.

## Reference material (read the one you need)

- `references/security.md` — the non-negotiable rules: never roll your own auth,
  RLS default-deny on every user-data table, env-var / `service_role` discipline,
  HTTPS, and the **Definition of Done** checklist.
- `references/supabase.md` — data-model template, the four RLS policies,
  `updated_at` trigger, realtime setup, auth (anonymous → magic link), and the
  server-side upsert-without-duplicates pattern. Copy-paste SQL.
- `references/build-phases.md` — the per-phase prompt templates, generalized from
  the to-do build so you can retarget them to any domain.
- `references/railway.md` — first-time click-by-click deploy, free HTTPS,
  Cloudflare proxy notes, and running an agent as a second cron service.
- `references/agents.md` — the per-user Zapier SDK sync-agent pattern (its own
  folder, `service_role` server-side, one agent per user).

## Bootstrapping a new repo

The fastest start is to drop a tailored `CLAUDE.md` into the new repo's root so
the AI follows these opinions every turn:

1. Copy `templates/CLAUDE.md` into the new repo root and fill in the
   `{{PLACEHOLDERS}}` (app name, domain model, lanes/states, integration source).
2. Copy `templates/.env.example` into the new repo root.
3. Open the AI in that repo and start Phase 1 — *"give me a static hello world."*

## Definition of done (check before calling any feature finished)

- [ ] **RLS verified** — an incognito window / a second user **cannot** see my data.
- [ ] **No secrets in the client bundle or git** — `service_role` is server-only.
- [ ] **Realtime works across two tabs.**
- [ ] **Deploys clean over HTTPS.**
