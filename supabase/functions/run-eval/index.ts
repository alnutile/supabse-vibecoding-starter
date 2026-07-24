// run-eval — the eval run engine (§4 of specs/evals/SPEC.md).
//
// Admin-gated Deno function. Input: { suite_id, prompt_version_id }.
// For each case it PRODUCES an answer under the version's prompt, then JUDGES
// that answer against the team-written `expected`. It writes one eval_run + one
// eval_result per case and returns the summary.
//
// All AI calls stay server-side — ANTHROPIC_API_KEY never reaches the browser.
// Writes use the CALLER's admin token, so RLS still applies (no service_role).
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

// Default model — fast + cheap for grading. A version may override via `model`.
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const KNOWN_MODELS = new Set([
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
])
const MAX_CASES = 40 // cap so a run fits the function's wall-clock

const JUDGE_RUBRIC =
  'You grade an AI answer. Given INPUT, EXPECTED (team-written), and ANSWER, decide if the answer ' +
  'satisfies EXPECTED. If EXPECTED describes a refusal/fallback, PASS only if the answer actually ' +
  'refuses/falls back that way. Otherwise PASS if it meets the expected outcome without fabricating. ' +
  'Return ONLY JSON: {"passed": true|false, "score": 0.0-1.0, "notes": "one short sentence"}.'

// One Anthropic Messages call → the concatenated text output.
// NOTE (§10 gotcha): never send `temperature` — it's deprecated on some models
// and a rejected call fails the whole grade. We omit it everywhere.
async function claude(key: string, model: string, system: string, user: string, maxTokens = 600) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`)
  }
  const data = await res.json()
  return (data.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('')
    .trim()
}

// Bounded concurrency: run `worker` over `items`, at most `n` in flight.
async function pool<T, R>(items: T[], n: number, worker: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await worker(items[idx])
    }
  })
  await Promise.all(runners)
  return out
}

type EvalCase = { id: string; name: string; input: string; expected: string; kind: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
  const KEY = Deno.env.get('ANTHROPIC_API_KEY')
  if (!KEY) return json({ error: 'ANTHROPIC_API_KEY is not configured on this project.' }, 500)

  const auth = req.headers.get('Authorization') ?? ''
  // Everything runs as the CALLER (their admin JWT) — RLS enforces admin.
  const db = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } } })

  const { data: u } = await db.auth.getUser()
  if (!u?.user) return json({ error: 'Not authenticated' }, 401)
  const { data: isAdmin } = await db.rpc('is_admin')
  if (!isAdmin) return json({ error: 'Admins only' }, 403)

  let body: { suite_id?: string; prompt_version_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const { suite_id, prompt_version_id } = body
  if (!suite_id || !prompt_version_id) {
    return json({ error: 'suite_id and prompt_version_id are required' }, 400)
  }

  // Load the version (the prompt under test) + its suite's cases.
  const { data: version, error: vErr } = await db
    .from('prompt_versions')
    .select('id, body, model')
    .eq('id', prompt_version_id)
    .maybeSingle()
  if (vErr) return json({ error: vErr.message }, 400)
  if (!version) return json({ error: 'Version not found' }, 404)

  const { data: cases, error: cErr } = await db
    .from('eval_cases')
    .select('id, name, input, expected, kind')
    .eq('suite_id', suite_id)
    .limit(MAX_CASES)
  if (cErr) return json({ error: cErr.message }, 400)
  if (!cases || cases.length === 0) return json({ error: 'Suite has no cases' }, 400)

  const model =
    version.model && KNOWN_MODELS.has(version.model) ? version.model : DEFAULT_MODEL
  const system = version.body || ''

  // Open the run first (status running) so a crash leaves a visible record.
  const { data: run, error: rErr } = await db
    .from('eval_runs')
    .insert({
      suite_id,
      prompt_version_id,
      status: 'running',
      run_by: u.user.id,
    })
    .select('id')
    .single()
  if (rErr || !run) return json({ error: rErr?.message ?? 'Could not open run' }, 400)

  async function grade(c: EvalCase) {
    try {
      const output = await claude(KEY!, model, system, c.input)
      const verdictRaw = await claude(
        KEY!,
        DEFAULT_MODEL,
        JUDGE_RUBRIC,
        `INPUT:\n${c.input}\n\nEXPECTED:\n${c.expected}\n\nANSWER:\n${output}`,
        200,
      )
      let passed = false
      let score = 0
      let notes = ''
      try {
        const m = verdictRaw.match(/\{[\s\S]*\}/)
        const v = JSON.parse(m ? m[0] : verdictRaw)
        passed = !!v.passed
        score = typeof v.score === 'number' ? v.score : passed ? 1 : 0
        notes = typeof v.notes === 'string' ? v.notes : ''
      } catch {
        notes = 'Judge returned unparseable output; scored as fail.'
      }
      return { case_id: c.id, output, passed, score, judge_notes: notes }
    } catch (err) {
      return {
        case_id: c.id,
        output: '',
        passed: false,
        score: 0,
        judge_notes: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  try {
    const results = await pool(cases as EvalCase[], 6, grade)

    await db.from('eval_results').insert(
      results.map((r) => ({
        run_id: run.id,
        case_id: r.case_id,
        output: r.output,
        passed: r.passed,
        score: r.score,
        judge_notes: r.judge_notes,
      })),
    )

    const total = results.length
    const passed = results.filter((r) => r.passed).length
    const score = total > 0 ? Math.round((passed / total) * 100) : 0

    await db
      .from('eval_runs')
      .update({ status: 'done', total, passed, score, finished_at: new Date().toISOString() })
      .eq('id', run.id)

    return json({ run_id: run.id, total, passed, score })
  } catch (err) {
    await db
      .from('eval_runs')
      .update({ status: 'failed', finished_at: new Date().toISOString() })
      .eq('id', run.id)
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
