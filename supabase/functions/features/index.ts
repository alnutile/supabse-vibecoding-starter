// supabase/functions/features/index.ts  (verify_jwt=true, ADMIN ONLY)
// The GitHub side of the Features kanban: approve → open a labeled issue;
// sync → find + refresh the linked PR; merge → squash-merge (= deploy).
import { createClient } from 'npm:@supabase/supabase-js@2'

const GITHUB_REPO = Deno.env.get('GITHUB_REPO') ?? 'alnutile/supabse-vibecoding-starter'
const GH_API = 'https://api.github.com'
const APPROVED_LABEL = 'approved-for-work'
const BUCKET = 'documents' // this starter's private bucket

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// verify_jwt=true means the gateway already validated the token; we only need the sub.
function userIdFromAuth(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof p.sub === 'string' ? p.sub : null
  } catch {
    return null
  }
}

// deno-lint-ignore no-explicit-any
async function gh(pat: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* some endpoints are empty */
  }
  return { ok: res.ok, status: res.status, data }
}

// deno-lint-ignore no-explicit-any
type DB = any

async function issueBody(db: DB, feature: { description: string; screenshots: string[]; id: string }): Promise<string> {
  const parts = [feature.description || '(no description provided)']
  const shots: string[] = []
  for (const path of feature.screenshots ?? []) {
    // 24h signed URLs: on a public repo the issue is world-readable, so keep the
    // window short — it only bounds NEW reads of the private original.
    const { data } = await db.storage.from(BUCKET).createSignedUrl(path, 24 * 3600)
    if (data?.signedUrl) shots.push(`![screenshot](${data.signedUrl})`)
  }
  if (shots.length) parts.push('## Screenshots', shots.join('\n\n'))
  parts.push(
    '---',
    '_Filed from the Features board. Implement this, run `npm run build` + `npm test`, and open a PR whose description contains `Closes #<this issue>`. Do not push to main._',
    `<!-- feature:${feature.id} -->`,
  )
  return parts.join('\n\n')
}

async function findLinkedPr(pat: string, issueNumber: number): Promise<{ number: number; url: string } | null> {
  const { ok, data } = await gh(pat, 'GET', `/repos/${GITHUB_REPO}/issues/${issueNumber}/timeline?per_page=100`)
  if (!ok || !Array.isArray(data)) return null
  let found: { number: number; url: string } | null = null
  for (const ev of data) {
    const src = ev?.source?.issue
    if (ev?.event === 'cross-referenced' && src?.pull_request && src?.number) {
      found = { number: src.number, url: src.pull_request.html_url ?? src.html_url }
    }
  }
  return found
}

async function syncRow(db: DB, pat: string, row: { id: string; issue_number: number | null; pr_number: number | null }) {
  let prNumber = row.pr_number
  let prUrl: string | undefined
  if (!prNumber && row.issue_number) {
    const linked = await findLinkedPr(pat, row.issue_number)
    if (linked) {
      prNumber = linked.number
      prUrl = linked.url
    }
  }
  if (!prNumber) return { pr_number: null, pr_state: null }
  const { ok, data } = await gh(pat, 'GET', `/repos/${GITHUB_REPO}/pulls/${prNumber}`)
  if (!ok) return { pr_number: prNumber, pr_state: null }
  const state = data.merged ? 'merged' : data.state
  const update: Record<string, unknown> = {
    pr_number: prNumber,
    pr_url: prUrl ?? data.html_url,
    pr_state: state,
    updated_at: new Date().toISOString(),
  }
  if (state === 'merged') update.lane = 'shipped'
  await db.from('features').update(update).eq('id', row.id)
  return update
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const userId = userIdFromAuth(req)
  if (!userId) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  if (!profile?.is_admin) return json({ error: 'Admins only.' }, 403)

  const pat = Deno.env.get('GITHUB_PAT')
  if (!pat) return json({ error: 'Set the GITHUB_PAT edge secret (a token with repo/issues/PR scope).' }, 400)

  let body: { action?: string; id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400)
  }
  const { action, id } = body
  if (!id) return json({ error: 'id is required.' }, 400)

  const { data: feature } = await db.from('features').select('*').eq('id', id).maybeSingle()
  if (!feature) return json({ error: 'Feature not found.' }, 404)

  try {
    if (action === 'approve') {
      if (feature.issue_number) return json({ error: 'An issue already exists for this feature.' }, 400)
      const { ok, status, data } = await gh(pat, 'POST', `/repos/${GITHUB_REPO}/issues`, {
        title: feature.title,
        body: await issueBody(db, feature),
        labels: [APPROVED_LABEL],
      })
      if (!ok) {
        const msg = `GitHub issue creation failed (${status}): ${data?.message ?? 'unknown'}`
        await db.from('features').update({ last_error: msg, updated_at: new Date().toISOString() }).eq('id', id)
        return json({ error: msg }, 502)
      }
      await db
        .from('features')
        .update({ lane: 'approved', issue_number: data.number, last_error: null, updated_at: new Date().toISOString() })
        .eq('id', id)
      return json({ ok: true, issue_number: data.number, issue_url: data.html_url })
    }

    if (action === 'sync') return json({ ok: true, ...(await syncRow(db, pat, feature)) })

    if (action === 'merge') {
      const synced = await syncRow(db, pat, feature)
      const prNumber = (synced.pr_number as number | null) ?? feature.pr_number
      if (!prNumber) return json({ error: 'No PR is linked to this feature yet.' }, 400)
      if (synced.pr_state === 'merged') return json({ ok: true, already: true })
      const { ok, status, data } = await gh(pat, 'PUT', `/repos/${GITHUB_REPO}/pulls/${prNumber}/merge`, { merge_method: 'squash' })
      if (!ok) {
        const msg = `Merge failed (${status}): ${data?.message ?? 'unknown'}`
        await db.from('features').update({ last_error: msg, lane: 'ready', updated_at: new Date().toISOString() }).eq('id', id)
        return json({ error: msg }, 502)
      }
      await db
        .from('features')
        .update({ lane: 'shipped', pr_state: 'merged', last_error: null, updated_at: new Date().toISOString() })
        .eq('id', id)
      return json({ ok: true })
    }

    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'error' }, 500)
  }
})
