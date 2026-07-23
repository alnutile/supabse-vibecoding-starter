# supabase-vibe-starter

> Support efforts like this by visiting my sponsor below and learn more about the Zapier SDK!

🚀 [https://bit.ly/4w9EuLX ](https://bit.ly/4w9EuLX )

📺 [Watch the Video](https://youtu.be/wP0s8BLi-ZM)

📖 [Read the Substack](https://dailyaistudio.substack.com/p/vibe-coding-with-confidence)

An opinionated **GitHub template** for vibe-coding a real app with confidence.
Start a new project from it and you get, working on day one:

- 🔐 **Auth** (email+password and magic link, open sign-up) — the app is gated
  behind a login.
- 🗂️ **Per-user data with Row Level Security** — a `documents` table where a user
  only ever sees their own rows.
- ⚡ **Realtime over websockets** — a change in one tab shows up in the others.
- 📦 **File storage** — a private bucket with per-user access; upload a document
  and it appears on your dashboard (served via short-lived signed URLs).
- ✅ **CI/CD** — GitHub Actions for typecheck + lint + test + build, and
  automatic Supabase migrations on push to `main`.

The whole point: instead of the built-in "for real" prompting that Lovable/Replit
bake in, this repo carries your own opinions — in `CLAUDE.md` and the
`vibe-coding-with-confidence` skill under `.claude/skills/` — so the AI builds the
same secure way every time.

## Use this template

1. Click **Use this template → Create a new repository** (or clone this repo).
2. Create a **Supabase** project.
3. Configure the pieces below, then run it.

> **Deploying and testing end to end?** [`DEPLOY.md`](DEPLOY.md) is the ordered,
> click-by-click runbook (GitHub → Supabase → Railway) with a verification
> checklist and common snags.

### 1. Supabase dashboard (one-time)

- **Authentication → Sign In / Providers → Email:** enabled, **"Confirm email"
  OFF** (magic links work once Email is on). Leave "Allow anonymous sign-ins" off.
- **Authentication → URL Configuration:** set **Site URL** to your deployed URL
  and add **both** origins to **Redirect URLs** so magic links work in dev and
  prod:
  - `http://localhost:5173/**`
  - `https://<your-app>.up.railway.app/**` (and any custom domain)

### 2. Apply the database + storage migrations

The SQL in [`supabase/migrations/`](supabase/migrations/) creates the `documents`
table (with RLS + realtime) and the private `documents` Storage bucket (with
per-user policies). Apply it via CI (below) or locally with the Supabase CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

### 3. Frontend env vars (local + Railway)

Only `VITE_`-prefixed, **public** values (Supabase → Project Settings → API):

| Var                      | Value                                        |
|--------------------------|----------------------------------------------|
| `VITE_SUPABASE_URL`      | `https://<your-project-ref>.supabase.co`     |
| `VITE_SUPABASE_ANON_KEY` | the project's anon/publishable key           |

Copy `.env.example` to `.env` and fill these in. **Never** put the `service_role`
key in a `VITE_` var or in git.

### 4. GitHub Actions secrets & variables

In **Settings → Secrets and variables → Actions**:

| Kind     | Name                    | Where to get it                                   |
|----------|-------------------------|---------------------------------------------------|
| Variable | `SUPABASE_PROJECT_REF`  | your project ref (public; it's in the API URL)    |
| Secret   | `SUPABASE_ACCESS_TOKEN` | Supabase → Account → Access Tokens                |
| Secret   | `SUPABASE_DB_PASSWORD`  | Supabase → Project → Settings → Database password |

The **CI** workflow needs nothing extra. The **migrations** workflow uses the
three above and runs on every push to `main` that touches `supabase/migrations/`.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest
npm run build      # typecheck + production build into dist/
npm start          # serve the built dist/ on $PORT (used by Railway)
```

## Deploy to Railway

Point a Railway project at your repo (New Project → Deploy from GitHub repo). It
reads `railway.json`: builds with `npm run build`, serves `dist/` on `$PORT` via
`npm start`. Set the two `VITE_` vars in the service Variables. Generate a domain
under Settings → Networking — **HTTPS is on by default**. Every push redeploys.

## What to change per project

- **`CLAUDE.md`** — retitle and describe your actual app.
- **The domain** — the `documents` table + dashboard are a live smoke-test of the
  stack. Rename/replace them with your real entities, keeping the same shape
  (RLS, realtime, storage). The `vibe-coding-with-confidence` skill has
  copy-paste patterns for new tables, auth, realtime, storage, and deploy.

## The method

`.claude/skills/vibe-coding-with-confidence/` encodes the security rules, the
phased build, and reusable patterns. It loads automatically in Claude Code —
prefer the **simplest thing that is still secure**, and keep RLS on for every
user-data table.
