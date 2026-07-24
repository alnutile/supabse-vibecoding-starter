import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { DocumentsPage } from './DocumentsPage'
import { FeaturesBoard } from './FeaturesBoard'

type Tab = 'docs' | 'features'

// Tabs map to real URLs so they're linkable/bookmarkable and the back button
// works — done with the History API (no router dependency; Vite's dev + preview
// servers already serve index.html for these paths on a hard refresh).
const pathToTab = (p: string): Tab => (p.replace(/\/+$/, '') === '/features' ? 'features' : 'docs')
const tabToPath = (t: Tab): string => (t === 'features' ? '/features' : '/')

// The signed-in shell: a sticky top nav with two tabs plus the user chip.
// Matches design-guide/version-001.
export function AppShell({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>(() => pathToTab(window.location.pathname))
  const email = session.user.email ?? ''
  const initial = (email.trim()[0] ?? '?').toUpperCase()

  // Keep the tab in sync when the user navigates with the browser back/forward.
  useEffect(() => {
    const onPop = () => setTab(pathToTab(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function go(next: Tab, e: MouseEvent<HTMLAnchorElement>) {
    // Let modified/middle clicks open a new tab natively.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return
    e.preventDefault()
    if (window.location.pathname !== tabToPath(next)) window.history.pushState({}, '', tabToPath(next))
    setTab(next)
  }

  return (
    <div>
      <nav className="nav">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          VibeCode
        </div>
        <div className="nav-tabs">
          <a className={`tab${tab === 'docs' ? ' active' : ''}`} href="/" onClick={(e) => go('docs', e)}>
            Documents
          </a>
          <a className={`tab${tab === 'features' ? ' active' : ''}`} href="/features" onClick={(e) => go('features', e)}>
            Feature requests
          </a>
        </div>
        <div className="nav-right">
          <span className="nav-email">{email}</span>
          <span className="avatar" title={email}>
            {initial}
          </span>
          <button className="btn" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </nav>

      {tab === 'docs' ? <DocumentsPage session={session} /> : <FeaturesBoard session={session} />}
    </div>
  )
}
