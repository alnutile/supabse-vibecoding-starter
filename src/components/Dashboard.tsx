import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, DOCUMENTS_BUCKET } from '../lib/supabase'
import { formatBytes } from '../lib/format'

type Doc = {
  id: string
  name: string
  storage_path: string
  mime_type: string | null
  size_bytes: number | null
  created_at: string
}

export function Dashboard({ session }: { session: Session }) {
  const userId = session.user.id
  const [docs, setDocs] = useState<Doc[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // RLS returns only this user's rows — no user_id filter needed here.
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .order('created_at', { ascending: false })
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
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'documents',
          filter: `user_id=eq.${userId}`,
        },
        () => load(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [userId, load])

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      // Object key is prefixed with the user's uid — Storage RLS enforces that
      // a user can only write under their own folder.
      const path = `${userId}/${crypto.randomUUID()}-${file.name}`
      const { error: upErr } = await supabase.storage
        .from(DOCUMENTS_BUCKET)
        .upload(path, file)
      if (upErr) throw upErr

      const { error: insErr } = await supabase.from('documents').insert({
        name: file.name,
        storage_path: path,
        mime_type: file.type || null,
        size_bytes: file.size,
      })
      if (insErr) throw insErr

      await load() // realtime also refreshes; this keeps it snappy
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  async function view(doc: Doc) {
    // Private bucket → hand out a short-lived signed URL to view/download.
    const { data, error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrl(doc.storage_path, 60)
    if (error) setError(error.message)
    else window.open(data.signedUrl, '_blank', 'noopener')
  }

  async function remove(doc: Doc) {
    setError(null)
    const { error: sErr } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .remove([doc.storage_path])
    if (sErr) {
      setError(sErr.message)
      return
    }
    const { error: dErr } = await supabase.from('documents').delete().eq('id', doc.id)
    if (dErr) setError(dErr.message)
    await load()
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Your documents</h1>
          <p className="muted">
            {session.user.email} · {docs.length} file{docs.length === 1 ? '' : 's'}
          </p>
        </div>
        <button className="btn" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      <label className={`upload${busy ? ' busy' : ''}`}>
        <input type="file" onChange={onUpload} disabled={busy} hidden />
        <span>{busy ? 'Uploading…' : '+ Upload a document'}</span>
      </label>

      {error && <p className="error">{error}</p>}

      {docs.length === 0 ? (
        <p className="muted empty">
          No documents yet. Upload one to prove storage + realtime are working.
        </p>
      ) : (
        <ul className="list">
          {docs.map((doc) => (
            <li key={doc.id} className="card doc">
              <div className="doc-main">
                <span className="doc-name">{doc.name}</span>
                <span className="muted small">
                  {doc.mime_type ?? 'file'} · {formatBytes(doc.size_bytes)} ·{' '}
                  {new Date(doc.created_at).toLocaleString()}
                </span>
              </div>
              <div className="doc-actions">
                <button className="link" onClick={() => view(doc)}>
                  View
                </button>
                <button className="link danger" onClick={() => remove(doc)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
