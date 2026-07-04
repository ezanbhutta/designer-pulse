import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { BrandLogo } from '../../components/ui/BrandLogo'
import { homePathFor, useAuth } from '../../hooks/useAuth'
import { supabaseConfigured } from '../../lib/supabase'
import { ErrorBanner } from '../../components/ui/ErrorBanner'

/**
 * Specific, actionable auth errors (spec §20.7) — never a bare
 * "Something went wrong". Unknown messages pass through verbatim so the
 * user always sees what the server actually said.
 */
function friendlyAuthError(raw: string): string {
  const msg = raw.toLowerCase()
  if (msg.includes('invalid login credentials')) {
    return "That email or password doesn't match. Try again."
  }
  if (msg.includes('email not confirmed')) {
    return "Your email isn't confirmed yet — open the link we sent to your inbox first."
  }
  if (msg.includes('rate limit') || msg.includes('too many')) {
    return 'Too many tries — wait a minute, then try again.'
  }
  if (msg.includes('fetch') || msg.includes('network')) {
    return "Can't reach the server — check your internet and try again."
  }
  return raw
}

function BrandMark() {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <BrandLogo className="h-12 w-12" />
      <div>
        <h1 className="text-2xl font-semibold leading-tight text-fg">Studio Pulse</h1>
        <p className="eyebrow mt-1.5">See how the design team is doing</p>
      </div>
    </div>
  )
}

/**
 * Sign-in (spec §14): server-side Supabase session via useAuth().signIn.
 * On success the session lands, useAuth resolves the profile, and the effect
 * below redirects to the role's home surface. Works in both themes (semantic
 * tokens only) and is fully keyboard operable.
 */
export default function LoginPage() {
  const { session, role, loading, signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Redirect once the session lands AND the profile role resolves (the role
  // arrives asynchronously after sign-in, so we watch it, not the promise).
  useEffect(() => {
    if (session && role) navigate(homePathFor(role), { replace: true })
  }, [session, role, navigate])

  // Session exists but no app_users profile is linked — say so specifically.
  useEffect(() => {
    if (session && !loading && !role) {
      setSubmitting(false)
      setError(
        "You're signed in, but your account isn't set up in Studio Pulse yet — ask your admin to add you.",
      )
    }
  }, [session, loading, role])

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    const { error: signInError } = await signIn(email.trim(), password)
    if (signInError) {
      setError(friendlyAuthError(signInError))
      setSubmitting(false)
    }
    // On success, stay in the "Signing in…" state until the role lands and
    // the redirect effect above fires.
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="card animate-fade-in flex flex-col gap-6 p-6 sm:p-8">
          <BrandMark />

          {!supabaseConfigured ? (
            <div
              role="alert"
              className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3"
            >
              <p className="text-sm font-medium text-fg">
                The app isn&apos;t connected to its database yet — see the README.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Set <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
                <code className="font-mono">VITE_SUPABASE_ANON_KEY</code>, then restart the dev
                server. Sign-in stays off until that&apos;s done.
              </p>
            </div>
          ) : (
            <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
              {error && <ErrorBanner message={error} />}

              <div className="flex flex-col gap-1.5">
                <label htmlFor="login-email" className="text-sm font-medium text-fg">
                  Email
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@studio.com"
                  className="min-h-[2.75rem] w-full rounded-xl border border-border bg-surface px-3.5 text-base text-fg placeholder:text-muted/60"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="login-password" className="text-sm font-medium text-fg">
                  Password
                </label>
                <input
                  id="login-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="min-h-[2.75rem] w-full rounded-xl border border-border bg-surface px-3.5 text-base text-fg placeholder:text-muted/60"
                />
              </div>

              <button
                type="submit"
                disabled={submitting || !email || !password}
                aria-busy={submitting}
                className="mt-1 min-h-[2.75rem] w-full rounded-xl bg-brand px-4 text-base font-semibold text-brand-fg transition-opacity duration-150 hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-muted">
          Everyone sees only their own part — designers see just their own numbers.
        </p>
      </div>
    </main>
  )
}
