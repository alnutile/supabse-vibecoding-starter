# Ground-truth reference

These files are the **real, in-production** source of the Features board, copied
verbatim from [supabase-as-a-service](https://github.com/alnutile/supabase-as-a-service)
(a React + Supabase team intranet). They are the source of truth: when the adapted
build-spec and the original disagree, the original is what actually ships. Read
them to see the fully-realized version, then follow `../references/build-spec.md`
to adapt it to this starter.

| File here | Origin path | Adapt for this starter → |
|---|---|---|
| `0048_features_board.sql` | `supabase/migrations/0048_features_board.sql` | Same table/RLS. Re-number as a **timestamp-prefixed** migration; depends on a `profiles.is_admin` (build-spec §1a adds a minimal one). |
| `0061_features_realtime.sql` | `supabase/migrations/0061_features_realtime.sql` | Idempotent publication add. In this starter just fold `alter publication supabase_realtime add table public.features;` into the features migration. |
| `features.function.index.ts` | `supabase/functions/features/index.ts` | Origin reads the GitHub PAT from **Supabase Vault** (`read_vault_secret` RPC, secret `github_pat`) and writes `activity_log`. Adapted version (build-spec §2) reads a **`GITHUB_PAT` edge secret** and drops `activity_log`. Logic (approve/sync/merge) is identical. |
| `FeaturesPage.tsx` | `src/pages/FeaturesPage.tsx` | Origin uses `react-router`, an `AuthContext`, tailwind design tokens (`bg-primary`, `text-muted`, …), and an `icons` module. Adapted version (build-spec §4) is plain CSS, `session`-based, no router. **If your project uses tailwind, keep this file nearly as-is.** |
| `features.ts` | `src/lib/features.ts` | **Drop-in, verbatim.** Pure `upsertFeature`/`removeFeature`. Copy to `src/lib/`. |
| `features.test.ts` | `src/lib/features.test.ts` | **Drop-in, verbatim.** Vitest tests for the above. |
| `claude-feature.yml` | `.github/workflows/claude-feature.yml` | Keep the trigger, OpenRouter wiring, prompt, and "verify a PR" step. Adapted version (build-spec §5) swaps the branch-CI steps to this starter's npm scripts and removes the Deno test steps. |

## What was intentionally left behind (origin-only infrastructure)

The origin app has supporting systems this feature *uses* but that aren't part of
the pipeline itself. The adapted build either substitutes a minimal version or
notes them as optional:

- **Supabase Vault** (`vault_secrets`, `read_vault_secret`) — origin's way of
  storing every credential. Substituted with an edge-function secret here. If you
  later add a vault, switch the token read back to it (more auditable).
- **`activity_log`** — origin logs `feature.approved` / `feature.shipped`.
  Dropped here; add back if you introduce an audit trail.
- **`profiles.is_admin`** — origin has a full profiles/roles system (first signup =
  admin, invite-only sign-up). Build-spec §1a adds the smallest version that
  preserves the trust boundary.
- **Deploy-on-merge workflows** — origin has `deploy-migrations.yml` /
  `deploy-functions.yml` plus Railway. This starter already deploys the app from
  `main` via Railway; add migration/function deploy workflows if your feature
  changes the schema or functions on merge.
