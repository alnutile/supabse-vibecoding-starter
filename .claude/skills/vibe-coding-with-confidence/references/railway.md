# Hosting on Railway (deploy from GitHub)

GitHub is just where the code lives so a host can grab it. Railway deploys from
the repo on **every push** and gives you **free HTTPS**. You don't need to be a
Git wizard — the AI can do most of the Git steps.

## Config the app needs

`package.json` — pin Node and serve the built output on Railway's `$PORT`:

```json
{
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "start": "vite preview --host 0.0.0.0 --port ${PORT:-4173}"
  }
}
```

`railway.json` — build with Nixpacks, then start:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS", "buildCommand": "npm run build" },
  "deploy": {
    "startCommand": "npm start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

Also add a `.nvmrc` so local + host agree on the Node version.

## First-time setup (click-by-click)

1. **Create the GitHub repo and push** (first commit made):
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git branch -M main
   git push -u origin main
   ```
2. **Create the Railway project:** railway.app → sign in with GitHub → **New
   Project** → **Deploy from GitHub repo** → authorize if prompted → pick the repo.
3. Railway reads `railway.json`, runs the build, then `npm start`.
4. **Get a public URL:** the service → **Settings** → **Networking** → **Generate
   Domain** → a `*.up.railway.app` URL. Open it. **HTTPS is on by default** —
   Railway terminates TLS on generated and custom domains; nothing to configure.

Every push to `main` redeploys automatically.

## Env vars on Railway

- Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the service **Variables**
  (these are the public keys; they get baked into the client bundle at build).
- **Never** set the `service_role` key on the web-app service — it belongs only on
  a separate server-side service (see agent below).

## Optional: Cloudflare proxy (a layer, not a force field)

The orange-cloud proxy adds baseline hardening: hides the origin, free edge TLS
("Always Use HTTPS"), DDoS absorption, a CDN, Bot Fight Mode, simple firewall
rules. It sits **in front of** your real auth + RLS — never a replacement.

SSL error when you first enable it? Set the DNS record to **DNS only (grey
cloud)** first, wait for the host to show the domain verified + certificate
issued, then turn the **orange cloud** back on and set SSL/TLS mode to **Full
(strict)**.

## Deploying an agent as a second service (hourly cron)

An agent is its **own** Railway service in the **same** repo:

1. Railway **project** → **New** → **GitHub Repo** → same repo.
2. New service → **Settings** → **Root Directory** = the agent's folder
   (e.g. `agents/<source>-sync`). It picks up that folder's own `railway.json`.
3. That `railway.json` runs on a cron and exits (a one-shot job):
   ```json
   {
     "$schema": "https://railway.app/railway.schema.json",
     "build": { "builder": "NIXPACKS" },
     "deploy": { "startCommand": "npm start", "cronSchedule": "0 * * * *",
                 "restartPolicyType": "NEVER" }
   }
   ```
4. Set the service's **Variables** (server-only): `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, the target `user_id`, the integration connection
   id, and any server credentials. **None** are `VITE_` vars.
5. Deploy. It runs every hour; hit **Deploy/Run** to trigger it on demand.
