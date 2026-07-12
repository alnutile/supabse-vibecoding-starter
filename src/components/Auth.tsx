import { useState } from 'react'
import { supabase } from '../lib/supabase'

type Mode = 'signin' | 'signup'

export function Auth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<Mode>('signin')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setMessage(null)
    try {
      await fn()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submitPassword = () =>
    run(async () => {
      const { error } =
        mode === 'signup'
          ? await supabase.auth.signUp({ email, password })
          : await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
    })

  const sendMagicLink = () =>
    run(async () => {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      })
      if (error) throw error
      setMessage('Check your email for a magic link.')
    })

  return (
    <div className="center">
      <div className="card auth">
        <h1>supabase-vibe-starter</h1>
        <p className="muted">
          Sign in to prove the stack works: auth, per-user data (RLS), realtime,
          and file storage.
        </p>

        <input
          className="input"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="input"
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          className="btn primary"
          disabled={busy || !email || !password}
          onClick={submitPassword}
        >
          {mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
        <button className="btn" disabled={busy || !email} onClick={sendMagicLink}>
          Email me a magic link
        </button>

        <button
          className="link"
          onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}
        >
          {mode === 'signup'
            ? 'Have an account? Sign in'
            : 'New here? Create an account'}
        </button>

        {message && <p className="notice">{message}</p>}
      </div>
    </div>
  )
}
