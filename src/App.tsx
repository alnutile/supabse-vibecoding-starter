import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import { Auth } from './components/Auth'
import { AppShell } from './components/AppShell'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  if (loading) {
    return <div className="center muted">Loading…</div>
  }

  // Auth gate: no session → login screen; a session → the app shell (tabs).
  return session ? <AppShell session={session} /> : <Auth />
}
