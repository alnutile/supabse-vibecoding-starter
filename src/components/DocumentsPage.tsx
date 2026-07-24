import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, DOCUMENTS_BUCKET } from '../lib/supabase'
import { formatBytes } from '../lib/format'
import { splitPinned } from '../lib/documents'

type Doc = {
  id: string
  name: string
  storage_path: string
  mime_type: string | null
  size_bytes: number | null
  notes: string | null
  pinned: boolean
  created_at: string
}

// Thumbnail palette per file kind (from the design guide's brand tints).
function fileStyle(ext: string): { grad: string; icon: string; badge: string } {
  const e = ext.toLowerCase()
  const blue = { grad: 'linear-gradient(150deg, #EDFBFF, #CEE9FD)', icon: '#0071FF', badge: '#0071FF' }
  const dark = { grad: 'linear-gradient(150deg, #E3EEF5, #CEE9FD)', icon: '#00182A', badge: '#00182A' }
  const bright = { grad: 'linear-gradient(150deg, #E7FBEF, #C9F2D9)', icon: '#00B854', badge: '#00B854' }
  if (['xls', 'xlsx', 'csv'].includes(e)) return bright
  if (['ppt', 'pptx', 'zip', 'key'].includes(e)) return dark
  return blue
}

const extOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > -1 ? name.slice(dot + 1) : 'file'
}

const FileIcon = ({ color, size = 34 }: { color: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.85 }}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8M8 17h5" />
  </svg>
)

const PinIcon = ({ filled = false, size = 16 }: { filled?: boolean; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7z" />
    {!filled && <circle cx="12" cy="9" r="2.5" />}
  </svg>
)

export function DocumentsPage({ session }: { session: Session }) {
  const userId = session.user.id
  const [docs, setDocs] = useState<Doc[]>([])
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [openId, setOpenId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftNotes, setDraftNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // RLS returns only this user's rows — no user_id filter needed here.
    const { data, error } = await supabase.from('documents').select('*').order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setDocs(data as Doc[])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Realtime over websockets — a row inserted in another tab shows up here.
  useEffect(() => {
    const channel = supabase
      .channel('documents')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents', filter: `user_id=eq.${userId}` }, () => load())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [userId, load])

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (!list.length) return
      setBusy(true)
      setError(null)
      try {
        for (const file of list) {
          // Object key is prefixed with the user's uid — Storage RLS enforces
          // a user can only write under their own folder.
          const path = `${userId}/${crypto.randomUUID()}-${file.name}`
          const { error: upErr } = await supabase.storage.from(DOCUMENTS_BUCKET).upload(path, file)
          if (upErr) throw upErr
          const { error: insErr } = await supabase.from('documents').insert({
            name: file.name,
            storage_path: path,
            mime_type: file.type || null,
            size_bytes: file.size,
          })
          if (insErr) throw insErr
        }
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [userId, load],
  )

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) uploadFiles(e.target.files)
    e.target.value = ''
  }
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files)
  }

  async function download(doc: Doc) {
    // Private bucket → hand out a short-lived signed URL to view/download.
    const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).createSignedUrl(doc.storage_path, 60)
    if (error) setError(error.message)
    else window.open(data.signedUrl, '_blank', 'noopener')
  }

  async function saveEdit(doc: Doc) {
    setError(null)
    const { error } = await supabase
      .from('documents')
      .update({ name: draftName.trim() || doc.name, notes: draftNotes })
      .eq('id', doc.id)
    if (error) setError(error.message)
    else {
      setEditing(false)
      await load()
    }
  }

  async function togglePin(doc: Doc) {
    setError(null)
    const { error } = await supabase.from('documents').update({ pinned: !doc.pinned }).eq('id', doc.id)
    if (error) setError(error.message)
    else await load()
  }

  async function remove(doc: Doc) {
    setError(null)
    const { error: sErr } = await supabase.storage.from(DOCUMENTS_BUCKET).remove([doc.storage_path])
    if (sErr) {
      setError(sErr.message)
      return
    }
    const { error: dErr } = await supabase.from('documents').delete().eq('id', doc.id)
    if (dErr) setError(dErr.message)
    setOpenId(null)
    await load()
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return docs
    return docs.filter(
      (d) => d.name.toLowerCase().includes(q) || (d.mime_type ?? '').toLowerCase().includes(q) || extOf(d.name).toLowerCase().includes(q),
    )
  }, [docs, query])

  const { pinned: pinnedDocs, rest: restDocs } = useMemo(() => splitPinned(filtered), [filtered])

  const openDoc = openId ? docs.find((d) => d.id === openId) ?? null : null

  function renderDocs(list: Doc[]) {
    if (view === 'grid') {
      return (
        <div className="doc-grid">
          {list.map((doc) => {
            const st = fileStyle(extOf(doc.name))
            return (
              <div key={doc.id} className={`doc-card${doc.pinned ? ' pinned' : ''}`} onClick={() => setOpenId(doc.id)}>
                <div className="doc-thumb" style={{ background: st.grad }}>
                  <div className="doc-thumb-sheen" />
                  <div className="doc-badge" style={{ background: st.badge }}>{extOf(doc.name).toUpperCase()}</div>
                  <FileIcon color={st.icon} />
                  <div className="doc-overlay">
                    <button className="btn primary" onClick={(e) => { e.stopPropagation(); download(doc) }}>View</button>
                  </div>
                </div>
                <div className="doc-meta">
                  <div className="txt">
                    <div className="doc-name" title={doc.name}>{doc.name}</div>
                    <div className="doc-sub">{formatBytes(doc.size_bytes)} · {new Date(doc.created_at).toLocaleDateString()}</div>
                  </div>
                  <button
                    className={`icon-btn${doc.pinned ? ' pin-active' : ''}`}
                    title={doc.pinned ? 'Unpin' : 'Pin to top'}
                    onClick={(e) => { e.stopPropagation(); togglePin(doc) }}
                  >
                    <PinIcon filled={doc.pinned} />
                  </button>
                  <button className="icon-btn" title="Delete" onClick={(e) => { e.stopPropagation(); remove(doc) }}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )
    }
    return (
      <div className="doc-listing">
        {list.map((doc) => {
          const st = fileStyle(extOf(doc.name))
          return (
            <div key={doc.id} className={`doc-row${doc.pinned ? ' pinned' : ''}`} onClick={() => setOpenId(doc.id)}>
              <div className="thumb-sm" style={{ background: st.grad }}>
                <FileIcon color={st.icon} size={22} />
              </div>
              <div className="txt" style={{ flex: 1, minWidth: 0 }}>
                <div className="doc-name" title={doc.name}>{doc.name}</div>
                <div className="doc-sub">{doc.mime_type ?? 'file'} · {formatBytes(doc.size_bytes)} · {new Date(doc.created_at).toLocaleString()}</div>
              </div>
              <button
                className={`icon-btn${doc.pinned ? ' pin-active' : ''}`}
                title={doc.pinned ? 'Unpin' : 'Pin to top'}
                onClick={(e) => { e.stopPropagation(); togglePin(doc) }}
              >
                <PinIcon filled={doc.pinned} />
              </button>
              <button className="icon-btn" title="Delete" onClick={(e) => { e.stopPropagation(); remove(doc) }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="page">
      <div className="container">
        <div className="page-head">
          <div>
            <h1>Your documents</h1>
            <div className="count-label">
              {docs.length} file{docs.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>

        <div className="toolbar">
          <div className="search">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#9BB1BE" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-3.5-3.5" />
            </svg>
            <input className="text-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search documents by name or type…" />
          </div>
          <div className="viewtoggle">
            <button className={view === 'grid' ? 'active' : ''} title="Grid view" onClick={() => setView('grid')}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </button>
            <button className={view === 'list' ? 'active' : ''} title="List view" onClick={() => setView('list')}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
              </svg>
            </button>
          </div>
        </div>

        <label className={`dropzone${busy ? ' busy' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <input type="file" multiple onChange={onPick} disabled={busy} hidden />
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 20h16" />
          </svg>
          {busy ? 'Uploading…' : 'Upload a document'}
          <span className="hint">or drop files here</span>
        </label>

        {error && <p className="error">{error}</p>}

        {filtered.length === 0 ? (
          <>
            <div className="section-label">{query ? '0 results' : 'All documents'}</div>
            <div className="empty-state">
              <div className="big">{query ? `No documents match “${query}”` : 'No documents yet'}</div>
              <div style={{ marginTop: 6, fontSize: 14 }}>{query ? 'Try a different name or file type.' : 'Upload one to prove storage + realtime are working.'}</div>
            </div>
          </>
        ) : (
          <>
            {pinnedDocs.length > 0 && (
              <>
                <div className="section-label pin-section-label">
                  <PinIcon filled size={12} /> Pinned
                </div>
                {renderDocs(pinnedDocs)}
              </>
            )}
            {(restDocs.length > 0 || pinnedDocs.length === 0) && (
              <>
                <div className="section-label" style={{ marginTop: pinnedDocs.length > 0 ? 24 : 0 }}>
                  {pinnedDocs.length > 0 ? 'Other documents' : query ? `${filtered.length} result${filtered.length === 1 ? '' : 's'}` : 'All documents'}
                </div>
                {renderDocs(restDocs)}
              </>
            )}
          </>
        )}
      </div>

      {openDoc && (
        <div className="overlay" onClick={() => { setOpenId(null); setEditing(false) }}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-hero" style={{ background: fileStyle(extOf(openDoc.name)).grad }}>
              <div className="doc-thumb-sheen" />
              <div className="doc-badge" style={{ background: fileStyle(extOf(openDoc.name)).badge, top: 14, left: 16 }}>{extOf(openDoc.name).toUpperCase()}</div>
              <button className="sheet-close" title="Close" onClick={() => { setOpenId(null); setEditing(false) }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
              <FileIcon color={fileStyle(extOf(openDoc.name)).icon} size={44} />
            </div>
            <div className="sheet-body">
              {editing ? (
                <>
                  <div className="field-label">Title</div>
                  <input className="text-input" style={{ fontWeight: 600 }} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
                  <div className="field-label">Notes</div>
                  <textarea className="textarea" rows={4} value={draftNotes} onChange={(e) => setDraftNotes(e.target.value)} />
                  <div className="sheet-actions">
                    <button className="btn primary" style={{ flex: 1 }} onClick={() => saveEdit(openDoc)}>Save changes</button>
                    <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <h2>{openDoc.name}</h2>
                  <div className="sheet-meta">{(openDoc.mime_type ?? 'file')} · {formatBytes(openDoc.size_bytes)} · {new Date(openDoc.created_at).toLocaleString()}</div>
                  <div className="field-label">Notes</div>
                  <div className="sheet-notes">{openDoc.notes?.trim() ? openDoc.notes : 'No notes yet.'}</div>
                  <div className="sheet-actions">
                    <button className="btn primary row" onClick={() => download(openDoc)}>
                      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
                      Download
                    </button>
                    <button className="btn row" onClick={() => { setEditing(true); setDraftName(openDoc.name); setDraftNotes(openDoc.notes ?? '') }}>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                      Edit
                    </button>
                    <button className={`btn row${openDoc.pinned ? ' pin-active' : ''}`} onClick={() => togglePin(openDoc)}>
                      <PinIcon filled={openDoc.pinned} size={15} />
                      {openDoc.pinned ? 'Unpin' : 'Pin to top'}
                    </button>
                    <button className="btn danger row" style={{ marginLeft: 'auto' }} onClick={() => remove(openDoc)}>
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" /></svg>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
