// Pure, testable AI-Quality logic (§5 of specs/evals/SPEC.md): the gate, the
// score chip, and the chip-publish rules. No React, no Supabase — just data in,
// verdict out — so the UI stays dumb and these rules stay unit-tested.

export type Tone = 'green' | 'amber' | 'red' | 'none'
export type VersionStatus = 'draft' | 'live' | 'archived'

/** The bits of an eval_run this logic needs (score is 0..100). */
export interface RunLike {
  total: number | null
  passed: number | null
  score?: number | null
}

/** A version is "green" when its latest run passed EVERY case. */
export function isVersionGreen(run: RunLike | null | undefined): boolean {
  return !!run && run.total != null && run.total > 0 && run.passed === run.total
}

export interface ScoreChip {
  label: string
  tone: Tone
}

/**
 * The chip shown on the home card / version rail for a version's latest run.
 *   green  "92% · 46/50 ✓"  — all cases passed
 *   red    "3 failing"       — a completed run with failures
 *   amber  "⚠ untested"      — a draft with no usable run yet
 *   none   "—"               — live/archived with no run
 */
export function scoreChip(run: RunLike | null | undefined, status: VersionStatus): ScoreChip {
  const hasRun = !!run && run.total != null && run.total > 0
  if (!hasRun) {
    return status === 'draft'
      ? { label: '⚠ untested', tone: 'amber' }
      : { label: '—', tone: 'none' }
  }
  const total = run!.total as number
  const passed = run!.passed ?? 0
  const pct =
    run!.score != null ? Math.round(run!.score) : Math.round((passed / total) * 100)
  if (passed === total) {
    return { label: `${pct}% · ${passed}/${total} ✓`, tone: 'green' }
  }
  const failing = total - passed
  return { label: `${failing} failing`, tone: 'red' }
}

export type PublishReason = 'not-draft' | 'no-case' | 'guardrail' | 'ok'

export interface PublishState {
  canPublish: boolean
  blocked: boolean
  reason: PublishReason
}

/**
 * Whether an Ask chip may be published. Publish only when it's a draft proven by
 * a CORE case (a guardrail case expects a refusal, so it can't prove a chip).
 */
export function questionPublishState({
  status,
  hasCase,
  guardCase,
}: {
  status: string
  hasCase: boolean
  guardCase: boolean
}): PublishState {
  if (status !== 'draft') return { canPublish: false, blocked: false, reason: 'not-draft' }
  if (!hasCase) return { canPublish: false, blocked: true, reason: 'no-case' }
  if (guardCase) return { canPublish: false, blocked: true, reason: 'guardrail' }
  return { canPublish: true, blocked: false, reason: 'ok' }
}
