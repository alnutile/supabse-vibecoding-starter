import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, DOCUMENTS_BUCKET } from '../lib/supabase'
import { removeFeature, upsertFeature } from '../lib/features'

type Lane = 'idea' | 'approved' | 'ready' | 'shipped'

type Feature = {
  id: string
  title: string
  description: string
  screenshots: string[]
  lane: Lane
  issue_number: number | null
  pr_number: number | null
  pr_url: string | null
  pr_state: string | null
  last_error: string | null
  owner_id: string | null
  created_at: string
  updated_at: string
}

const LANES: { key: Lane; title: string; hint: string }[] = [
  { key: 'idea', title: 'Ideas', hint: 'Anyone can add. Screenshots welcome.' },
  { key: 'approved', title: 'Approved for work', hint: 'AI builds it and opens a PR.' },
  { key: 'ready', title: 'Approved to merge', hint: 'Dropping here merges the PR.' },
  { key: 'shipped', title: 'Shipped', hint: 'Merged — deploy runs from main.' },
]

const PUBLIC_WARNING =
  'Approving files a GitHub issue with this card’s title, description, and screenshots, then spends AI credits to build it. On a public repo that issue is world-readable. Continue?'
const DEPLOY_WARNING = 'This squash-merges the linked PR into main — which deploys to production. Continue?'

// The features edge function (approve / sync / merge) — admin-only, server-side.
async function callFeaturesFn(action: 'approve' | 'sync' | 'merge', id: string) {
  const { data: sess } = await supabase.auth.getSession()
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/features`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sess.session?.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action, id }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function FeaturesBoard({ session }: { session: Session }) {
  const userId = session.user.id
  const [features, setFeatures] = useState<Feature[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overLane, setOverLane] = useState<Lane | null>(null)
  const didSync = useRef(false)

  // New-idea modal
  const [newOpen, setNewOpen] = useState(false)
  const [niTitle, setNiTitle] = useState('')
  const [niDesc, setNiDesc] = useState('')
  const [niFiles, setNiFiles] = useState<File[]>([])
  const [niBusy, setNiBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('features').select('*').order('updated_at', { ascending: false })
    if (error) setError(error.message)
    else setFeatures((data as Feature[]) ?? [])
  }, [])

  useEffect(() => {
    load()
    supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(!!data?.is_admin))
  }, [load, userId])

  // Live board — PR links land asynchronously via the edge function's sync.
  useEffect(() => {
    const channel = supabase
      .channel('features')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'features' }, (payload) => {
        setFeatures((list) => {
          if (payload.eventType === 'DELETE') return removeFeature(list, (payload.old as { id: string }).id)
          return upsertFeature(list, payload.new as Feature)
        })
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  // Once, as admin: refresh PR state for in-flight cards (picks up newly opened PRs).
  useEffect(() => {
    if (!isAdmin || didSync.current || features.length === 0) return
    didSync.current = true
    features
      .filter((f) => f.issue_number && f.pr_state !== 'merged' && (f.lane === 'approved' || f.lane === 'ready'))
      .forEach((f) => callFeaturesFn('sync', f.id).catch(() => {}))
  }, [isAdmin, features])

  async function moveTo(card: Feature, toLane: Lane) {
    if (!isAdmin || toLane === card.lane) return
    setError(null)
    try {
      if (toLane === 'approved') {
        if (!window.confirm(PUBLIC_WARNING)) return
        setBusyId(card.id)
        await callFeaturesFn('approve', card.id)
      } else if (toLane === 'ready') {
        if (!window.confirm(DEPLOY_WARNING)) return
        setBusyId(card.id)
        // Move it visibly first, then merge (the fn flips it to shipped on success).
        await supabase.from('features').update({ lane: 'ready' }).eq('id', card.id)
        await callFeaturesFn('merge', card.id)
      } else {
        await supabase.from('features').update({ lane: toLane }).eq('id', card.id)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      await load()
    } finally {
      setBusyId(null)
    }
  }

  async function submitIdea() {
    if (!niTitle.trim()) return
    setNiBusy(true)
    setError(null)
    try {
      const paths: string[] = []
      for (const file of niFiles) {
        const path = `${userId}/features/${crypto.randomUUID()}-${file.name}`
        const { error: upErr } = await supabase.storage.from(DOCUMENTS_BUCKET).upload(path, file)
        if (upErr) throw upErr
        paths.push(path)
      }
      const { error: insErr } = await supabase
        .from('features')
        .insert({ title: niTitle.trim(), description: niDesc.trim(), screenshots: paths, owner_id: userId, lane: 'idea' })
      if (insErr) throw insErr
      setNewOpen(false)
      setNiTitle('')
      setNiDesc('')
      setNiFiles([])
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setNiBusy(false)
    }
  }

  const shippedCount = features.filter((f) => f.lane === 'shipped').length

  return (
    <div className="page">
      <div className="container">
        <div className="board-head">
          <div>
            <h1>Features</h1>
            <p className="subtitle">
              Ideas in, shipped code out. Dragging a card is the approval: into <strong>Approved for work</strong> the AI builds it (PR for
              review); into <strong>Approved to merge</strong> the PR merges and deploys.
            </p>
          </div>
          <button className="btn primary row" onClick={() => setNewOpen(true)}>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New idea
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        {!isAdmin && (
          <p className="subtitle" style={{ marginBottom: 16 }}>
            You can file ideas here. Moving cards (approve / merge) is admin-only.
          </p>
        )}

        <div className="board">
          {LANES.map((lane) => {
            const cards = features.filter((f) => f.lane === lane.key)
            return (
              <div
                key={lane.key}
                className={`lane${overLane === lane.key ? ' over' : ''}`}
                onDragOver={(e) => {
                  if (!isAdmin) return
                  e.preventDefault()
                  if (overLane !== lane.key) setOverLane(lane.key)
                }}
                onDragLeave={() => setOverLane((l) => (l === lane.key ? null : l))}
                onDrop={(e) => {
                  e.preventDefault()
                  setOverLane(null)
                  const card = features.find((f) => f.id === dragId)
                  setDragId(null)
                  if (card) moveTo(card, lane.key)
                }}
              >
                <div className="lane-head">
                  <span className="lane-title">{lane.title}</span>
                  <span className="lane-count">{lane.key === 'shipped' ? shippedCount : cards.length}</span>
                </div>
                <div className="lane-hint">{lane.hint}</div>
                {cards.length === 0 ? (
                  <div className="lane-empty">Empty</div>
                ) : (
                  <div className="lane-cards">
                    {cards.map((card) => (
                      <FeatureCard
                        key={card.id}
                        card={card}
                        draggable={isAdmin && busyId !== card.id}
                        dragging={dragId === card.id}
                        busy={busyId === card.id}
                        onDragStart={() => setDragId(card.id)}
                        onDragEnd={() => {
                          setDragId(null)
                          setOverLane(null)
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {newOpen && (
        <div className="overlay" onClick={() => !niBusy && setNewOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-body">
              <h2>New idea</h2>
              <div className="sheet-meta">The description is read verbatim by the coding agent — say where the change goes and what “done” looks like.</div>
              <div className="field-label" style={{ marginTop: 18 }}>Title</div>
              <input className="text-input" style={{ fontWeight: 600 }} value={niTitle} onChange={(e) => setNiTitle(e.target.value)} placeholder="Short summary of the idea" />
              <div className="field-label">Description</div>
              <textarea className="textarea" rows={5} value={niDesc} onChange={(e) => setNiDesc(e.target.value)} placeholder="What should change, where, and how you'll know it's done." />
              <div className="field-label">Screenshots (optional)</div>
              <input type="file" multiple accept="image/*" onChange={(e: ChangeEvent<HTMLInputElement>) => setNiFiles(Array.from(e.target.files ?? []))} />
              {niFiles.length > 0 && <div className="sheet-meta" style={{ marginTop: 8 }}>{niFiles.length} file{niFiles.length === 1 ? '' : 's'} attached</div>}
              <div className="sheet-actions">
                <button className="btn primary" style={{ flex: 1 }} disabled={niBusy || !niTitle.trim()} onClick={submitIdea}>
                  {niBusy ? 'Filing…' : 'File idea'}
                </button>
                <button className="btn" disabled={niBusy} onClick={() => setNewOpen(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FeatureCard({
  card,
  draggable,
  dragging,
  busy,
  onDragStart,
  onDragEnd,
}: {
  card: Feature
  draggable: boolean
  dragging: boolean
  busy: boolean
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const prClass = card.pr_state === 'merged' ? 'pr-merged' : card.pr_state === 'closed' ? 'pr-closed' : 'pr-open'
  const building = card.lane === 'approved' && !card.pr_number
  return (
    <div
      className={`feat-card${draggable ? ' draggable' : ''}${dragging ? ' dragging' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="feat-title">{card.title}</div>
      {card.description && <div className="feat-desc">{card.description}</div>}
      <div className="feat-meta">
        {card.screenshots.length > 0 && (
          <span className="chip plain">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            {card.screenshots.length}
          </span>
        )}
        {card.issue_number && <span className="chip">#{card.issue_number}</span>}
        {card.pr_number && (
          <a className={`chip ${prClass}`} href={card.pr_url ?? undefined} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
            </svg>
            PR {card.pr_number} · {card.pr_state}
          </a>
        )}
        {(building || busy) && <span className="chip building">{busy ? 'working…' : 'building…'}</span>}
        <span className="feat-date">{shortDate(card.created_at)}</span>
      </div>
      {card.last_error && <div className="feat-error">{card.last_error}</div>}
    </div>
  )
}
