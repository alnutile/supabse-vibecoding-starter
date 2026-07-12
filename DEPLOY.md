# Deploy & test end to end

This starter needs three accounts: **GitHub** (where the code lives), **Supabase**
(database, auth, realtime, storage), and **Railway** (hosting). Do them in this
order — Railway deploys *from* GitHub, so GitHub comes first.

> You do **not** need a paid Supabase to test end to end. The **free tier** is
> fully hosted and includes auth, RLS, realtime, and storage. Go paid only when
> you want it for real (no project pausing, uptime, scale).

## 1. GitHub

1. Create a repo from this template (**Use this template → Create a new
   repository**) or push this code to a new empty repo.
2. On the first push to `main`, the **CI** workflow runs (typecheck, lint, test,
   build). The **migrations** workflow also triggers but will fail until you set
   its secrets in step 2 — that's expected; you'll run it manually.

## 2. Supabase (free tier is fine)

1. Create a project.
2. **Project Settings → API** — copy the **Project URL** and the **anon /
   publishable key** (both are public and safe client-side). You'll use them in
   step 3. Never copy the `service_role` key into the app or a `VITE_` var.
3. **Authentication → Sign In / Providers → Email:** enabled, **"Confirm email"
   OFF** (magic links work once Email is on). Leave anonymous sign-ins off.
4. **Authentication → URL Configuration → Redirect URLs:** add
   `http://localhost:5173/**` now; add your Railway URL after step 4.
5. **Apply the migrations** (creates the `documents` table + private Storage
   bucket + all the RLS policies). In the GitHub repo, **Settings → Secrets and
   variables → Actions**:
   - Variable `SUPABASE_PROJECT_REF` — your project ref (public; it's in the API URL).
   - Secret `SUPABASE_ACCESS_TOKEN` — Supabase → Account → Access Tokens.
   - Secret `SUPABASE_DB_PASSWORD` — Supabase → Project → Settings → Database password.

   Then **Actions → "Apply Supabase migrations" → Run workflow**. (Or apply
   locally: `supabase link --project-ref <ref>` then `supabase db push`.)

## 3. Local smoke test (optional but recommended)

```bash
cp .env.example .env      # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY from step 2.2
npm install
npm run dev               # http://localhost:5173
```

Sign up, upload a document, open a second tab → it appears live. That already
proves auth + RLS + realtime + storage against your real project.

## 4. Railway

1. **New Project → Deploy from GitHub repo →** pick this repo. It reads
   `railway.json`: builds with `npm run build`, serves `dist/` on `$PORT` via
   `npm start`.
2. Service **Variables:** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the
   two public values from step 2.2). These are baked into the client bundle at
   build, so redeploy after setting them.
3. **Settings → Networking → Generate Domain** → a `*.up.railway.app` HTTPS URL.
   **HTTPS is on by default.**
4. Add `https://<your-domain>/**` to Supabase **Redirect URLs** (step 2.4) so
   magic links and post-login redirects work in production.

Every push to `main` redeploys automatically.

## 5. Verify (the Definition of Done)

- [ ] Sign up / sign in works (password **and** magic link).
- [ ] Upload a document → it appears on the dashboard; **View** opens it.
- [ ] Open a second tab → uploading in one shows up live in the other (realtime).
- [ ] An incognito window / a second account sees **none** of your documents
      (RLS — table and Storage).
- [ ] Only `VITE_` public keys are in the client / Railway; no `service_role`
      key anywhere client-side or in git.
- [ ] The site is served over **HTTPS**.

## Common snags

- **Magic link / login redirect fails** → the current origin isn't in Supabase
  **Redirect URLs**. Add both the localhost and the Railway origins.
- **Migrations workflow red** → `SUPABASE_PROJECT_REF` variable or the two
  secrets aren't set. Set them, then re-run the workflow.
- **Uploads or reads denied** → confirm the migrations ran (the `documents`
  bucket and its `storage.objects` policies exist).
