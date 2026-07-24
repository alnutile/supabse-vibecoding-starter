# AI Quality — port status

Tracks the port of `SPEC.md` into this starter, against the §9 ship checklist.
This first pass builds the **foundation** (everything design-independent); the
admin UI waits on design files.

## Decisions (differ from SPEC where noted)

- **Admin gate.** `is_admin()` reads `is_admin` from the caller's Supabase
  `app_metadata` (`auth.users.raw_app_meta_data`) — NOT an email-domain wildcard.
  Only the service_role / Admin API can write app_metadata, so a user can't
  self-escalate. Make yourself admin once:
  ```sql
  update auth.users
     set raw_app_meta_data = raw_app_meta_data || '{"is_admin": true}'::jsonb
   where email = 'you@example.com';
  ```
- **Feature flags.** Not built. The AI Quality nav item will be gated on
  `is_admin()` alone (SPEC §2d flags deferred).

## Done ✅

- [x] **Prereqs (§2)** — `supabase/migrations/20260721120000_ai_quality_prereqs.sql`:
      `is_admin()`, `prompts`, `skills` (RLS admin-only, `set_updated_at` reused).
- [x] **Core schema + promote gate (§3)** — `..._20260721120100_ai_quality_evals.sql`:
      `prompt_versions` (one-live partial unique index), `eval_suites`,
      `eval_cases`, `eval_runs`, `eval_results`, `ask_questions`, RLS + the
      `promote_prompt_version(uuid, text)` RPC. Drop-first triggers/policies.
- [x] **Seed (§8)** — `..._20260721120200_ai_quality_seed.sql`: a `support_reply`
      prompt (v1 archived / v2 live / v3 draft), a suite of core + guardrail
      cases, a green baseline run, and Ask chips. Idempotent.
- [x] **run-eval engine (§4)** — `supabase/functions/run-eval/index.ts`:
      admin-gated, produce→judge per case, bounded concurrency, writes run +
      results with the caller's admin token (RLS). No `temperature` sent (§10).
- [x] **Pure logic (§5)** — `src/lib/evals.ts` + `src/lib/evals.test.ts`:
      `isVersionGreen`, `scoreChip`, `questionPublishState` (unit-tested).
- [x] **Deploy wiring** — `.github/workflows/supabase-functions.yml` (deploys
      `run-eval`, syncs `ANTHROPIC_API_KEY` from a GH secret); `.env.example`
      notes the server-only key; eslint ignores `supabase/functions` (Deno).

## Remaining ⏳

- [ ] **Admin UI (§5)** — `src/components/admin/AiQualityAdmin.tsx`: Home cards +
      Detail tabs (Versions / Cases / Results / Ask questions). **Waiting on
      design files** (companion `specs/evals/DESIGN.md`).
- [ ] **Nav item + route** to the workbench, gated on `is_admin()`.
- [ ] **(optional) MCP tools (§6)** and **Ask consumer (§7)**.

## Before shipping

1. Set `ANTHROPIC_API_KEY` on the Supabase project (or the GH Actions secret).
2. Apply migrations (`supabase db push` / the migrations workflow); verify
   one-live-per-prompt and that a non-admin can't read the workbench tables.
3. Grant yourself admin (SQL above), then run a suite from the UI once it lands.
