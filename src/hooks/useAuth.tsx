import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { fetchMyProfile } from '../lib/queries'
import type { AppUser, Role } from '../../shared/types'

interface AuthState {
  session: Session | null
  profile: AppUser | null
  role: Role | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<AppUser | null>(null)
  // Gate routing until the persisted session has actually been read —
  // otherwise deep links bounce through /login before auth resolves.
  const [sessionReady, setSessionReady] = useState(false)
  // 'idle' covers the render gap between session arrival and the profile
  // fetch effect running; without it RequireRole sees role=null and bounces.
  const [profileState, setProfileState] = useState<'idle' | 'loading' | 'done'>('idle')
  // undefined = no session seen yet this page load (never clear on the first
  // resolution — that's restore, not a switch).
  const lastUserId = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    // Every query key is identical across users/roles while the ROWS are
    // RLS-scoped per user — so on sign-out or a user switch the cache must be
    // dropped, or the next user is served the previous user's rows for up to
    // the staleTime window.
    const trackUser = (s: Session | null) => {
      const uid = s?.user?.id ?? null
      if (lastUserId.current !== undefined && lastUserId.current !== uid) {
        queryClient.clear()
      }
      lastUserId.current = uid
    }
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      trackUser(data.session)
      setSession(data.session)
      setSessionReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      trackUser(s)
      setSession(s)
      setSessionReady(true)
      if (!s) setProfile(null)
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [queryClient])

  const userId = session?.user?.id ?? null
  useEffect(() => {
    let cancelled = false
    if (!sessionReady) return
    if (!userId) {
      setProfile(null)
      setProfileState('done')
      return
    }
    setProfileState('loading')
    fetchMyProfile()
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch(() => {
        if (!cancelled) setProfile(null)
      })
      .finally(() => {
        if (!cancelled) setProfileState('done')
      })
    return () => {
      cancelled = true
    }
  }, [userId, sessionReady])

  const loading = !sessionReady || (!!session && !profile && profileState !== 'done')

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      role: profile?.role ?? null,
      loading,
      signIn: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        return { error: error?.message ?? null }
      },
      signOut: async () => {
        await supabase.auth.signOut()
      },
    }),
    [session, profile, loading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export const OPS_ROLES: Role[] = ['admin', 'manager', 'pm', 'hr']

export function homePathFor(role: Role | null): string {
  if (!role) return '/login'
  if (role === 'ceo') return '/ceo'
  if (role === 'designer') return '/me'
  return '/ops'
}
