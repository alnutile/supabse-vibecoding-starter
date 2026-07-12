# Build phases — reusable prompt templates

Generalized from the to-do build. Each phase **ships and is reachable before the
next begins**. Fill the `{{PLACEHOLDERS}}` for your domain. Every prompt should
start with *"Follow CLAUDE.md in this repo."* so the guardrails apply.

The golden rule of each phase: **do this phase and STOP.** Don't pull work forward
from a later phase.

---

## Phase 1 — Static hello world + deploy

> Follow CLAUDE.md. This is Step 1 — the "static hello world" stage. Keep it
> simple. **No database and no auth yet.**
>
> Build a static **{{APP_NAME}}** as a Vite + React + TypeScript app:
> - A single page titled "{{APP_NAME}}".
> - The core interaction: {{CORE_UI — e.g. an input + Add button, a list of
>   {{ENTITY}} with done/delete}}.
> - Persist to the browser with `localStorage` so a refresh keeps state — fine
>   for now; we move to a real database next.
> - Clean, minimal styling. No backend.
>
> Then set it up to **deploy to Railway from GitHub**: init git + first commit;
> add `.gitignore` (node_modules, dist, .env) and a `.env.example` placeholder;
> add the config Railway needs to build the Vite app and serve `dist/` on `$PORT`
> (e.g. `vite preview --host 0.0.0.0 --port $PORT`). Give me the exact
> click-by-click first-time setup and confirm HTTPS is on by default.
>
> Stop once it's deployed and reachable. Do NOT add a database, auth, or realtime.

---

## Phase 2 — Real database + realtime (anonymous auth)

> Follow CLAUDE.md. Step 2 — make it REAL with a database, auth simple for now
> (anonymous). No login screen yet.
>
> Replace localStorage with Supabase:
> - Use Supabase **anonymous** authentication so I get a session automatically.
> - Create a `{{TABLE}}` table per CLAUDE.md (id, user_id default auth.uid(),
>   {{DOMAIN FIELDS}}, status enum [{{STATES}}], position, created_at, updated_at).
> - Turn **RLS ON now**, policies gated on `user_id = auth.uid()` for
>   select/insert/update/delete — even at the anonymous stage.
> - Build the core UI backed by the DB; a change **persists immediately**.
> - Use Supabase **Realtime (websockets)** so a second tab updates live.
> - Env discipline: only the Supabase URL + anon key in `VITE_` vars; never the
>   `service_role` key. Update `.env.example` with placeholders.
>
> Redeploy to Railway (set the `VITE_` env vars there) and confirm it works live
> over HTTPS. Stop — do NOT add real accounts / login yet.

---

## Phase 3 — Real accounts (magic links + open sign-up)

> Follow CLAUDE.md. Step 3 — swap anonymous auth for REAL user accounts.
> Everything else keeps working.
>
> Auth changes (Supabase): turn ON email/password registration, sign-up **open**;
> also allow passwordless **magic link** sign-in; **do NOT require email
> confirmation** (note in README I can tighten later); **REMOVE anonymous auth
> entirely.**
>
> UI: add a login / sign-up screen (email+password and "send me a magic link");
> **gate everything behind a session** (logged-out → login screen); add a visible
> "Sign out" button.
>
> Security (verify, don't assume): confirm RLS is still ON and policies are
> `user_id = auth.uid()` for all four operations, so a user only sees their own
> rows. Still only URL + anon key in `VITE_` vars; no `service_role` anywhere
> client-side or in git.
>
> Config gotcha: set Supabase Auth **Site URL** and **Redirect URLs** to BOTH my
> local dev URL and my deployed domain, so magic links work in dev AND prod. Tell
> me exactly where.
>
> Redeploy and confirm: I can register, log in (password AND magic link), see only
> my own rows, sign out, and an incognito window is bounced to the login screen.

---

## Phase 4 — Design polish (presentation only)

> Follow CLAUDE.md. Restyle **{{APP_NAME}}** to match {{DESIGN_REFERENCE}}. This
> is a **presentation-only** change — do NOT change or remove any functionality:
> keep the auth gate, per-user data + RLS, realtime sync, and persistence all
> working exactly as they do now. Only the look changes.
>
> After: confirm the app still builds, auth still gates, data still saves
> per-user, realtime still updates a second tab, and every interaction still
> persists.

Tip: design the look in a visual tool (e.g. Claude's design surface), export the
tokens/prompt, and hand it to the coding agent as the reference — but always
fence it as presentation-only so functionality is untouched.

---

## Phase 5 — Per-user sync agent (the finale)

A small, **separate** server-side service that pulls from a system you already
own (e.g. Google Tasks) into your table. See `references/agents.md` for the full
pattern and `references/railway.md` for deploying it as a second cron service.
Key rules: its own folder + deps; `service_role` server-side only; **one agent
per user**, scoped to that user's connection and `user_id`; upsert on a stable
`external_id` so re-runs don't duplicate.

Hard-won debugging lessons from building one:
- **A process that dies with no output** is usually hard-killed or throwing away
  its logs on exit — make it log **synchronously and loudly** before theorizing.
- **"Half of it worked" doesn't mean auth is fine** — a metadata call (listing)
  can pass while the real action (reading) is denied. Test the real action early.
- **Scope credentials to the actions they need** — and no more.
