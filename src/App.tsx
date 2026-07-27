import { Suspense, lazy, useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { OPS_ROLES, homePathFor, useAuth } from './hooks/useAuth'
import { useRealtimeInvalidation } from './hooks/useRealtime'
import { useSyncTick } from './hooks/useSyncTick'
import type { Role } from '../shared/types'

const LoginPage = lazy(() => import('./pages/auth/LoginPage'))
const OpsLayout = lazy(() => import('./pages/ops/OpsLayout'))
const OpsHome = lazy(() => import('./pages/ops/OpsHome'))
const OpsBoard = lazy(() => import('./pages/ops/OpsBoard'))
const OpsTeam = lazy(() => import('./pages/ops/OpsTeam'))
const OpsAlerts = lazy(() => import('./pages/ops/OpsAlerts'))
const OpsReports = lazy(() => import('./pages/ops/OpsReports'))
const CeoLayout = lazy(() => import('./pages/ceo/CeoLayout'))
const CeoOverview = lazy(() => import('./pages/ceo/CeoOverview'))
const CeoTeams = lazy(() => import('./pages/ceo/CeoTeams'))
const CeoTrends = lazy(() => import('./pages/ceo/CeoTrends'))
const CeoReports = lazy(() => import('./pages/ceo/CeoReports'))
const CeoCancellations = lazy(() => import('./pages/ceo/CeoCancellations'))
const DesignerSelfView = lazy(() => import('./pages/designer/DesignerSelfView'))

/** Dark-first cockpit; light designer self-view (§21.9). User override persists. */
function useSurfaceTheme() {
  const location = useLocation()
  useEffect(() => {
    const stored = localStorage.getItem('theme')
    const isCockpit = location.pathname.startsWith('/ops') || location.pathname.startsWith('/ceo')
    const dark = stored ? stored === 'dark' : isCockpit
    document.documentElement.classList.toggle('dark', dark)
  }, [location.pathname])
}

function RequireRole({ allow, children }: { allow: Role[]; children: JSX.Element }) {
  const { session, role, loading } = useAuth()
  if (loading) return <PageFallback />
  if (!session) return <Navigate to="/login" replace />
  if (!role || !allow.includes(role)) return <Navigate to={homePathFor(role)} replace />
  return children
}

function PageFallback() {
  return (
    <div className="min-h-screen bg-bg p-8" role="status" aria-label="Loading">
      <div className="skeleton h-8 w-64 mb-6" />
      <div className="skeleton h-32 w-full mb-4" />
      <div className="skeleton h-64 w-full" />
    </div>
  )
}

export default function App() {
  useSurfaceTheme()
  useRealtimeInvalidation()
  useSyncTick()
  const { role } = useAuth()

  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route
          path="/ops"
          element={
            <RequireRole allow={OPS_ROLES}>
              <OpsLayout />
            </RequireRole>
          }
        >
          <Route index element={<OpsHome />} />
          <Route path="work" element={<OpsBoard />} />
          {/* The Board became the Work workspace. Existing links, bookmarks and
              the drill in from the Command Center all still land correctly. */}
          <Route path="board" element={<Navigate to="/ops/work" replace />} />
          <Route path="team" element={<OpsTeam />} />
          {/* Roster, Attendance, Leave and Onsite became views of Team. Every
              old link still lands on the right reading of the right page. */}
          <Route path="roster" element={<Navigate to="/ops/team" replace />} />
          <Route path="attendance" element={<Navigate to="/ops/team?view=today" replace />} />
          <Route path="leave" element={<Navigate to="/ops/team?view=time-off" replace />} />
          <Route path="onsite" element={<Navigate to="/ops/team?view=onsite" replace />} />
          {/* Alerts folded into Work; the full log stays reachable by link. */}
          <Route path="alerts" element={<OpsAlerts />} />
          <Route path="reports" element={<OpsReports />} />
        </Route>

        <Route
          path="/ceo"
          element={
            <RequireRole allow={['ceo', 'admin']}>
              <CeoLayout />
            </RequireRole>
          }
        >
          <Route index element={<CeoOverview />} />
          <Route path="teams" element={<CeoTeams />} />
          <Route path="trends" element={<CeoTrends />} />
          <Route path="reports" element={<CeoReports />} />
          <Route path="cancellations" element={<CeoCancellations />} />
        </Route>

        <Route
          path="/me"
          element={
            <RequireRole allow={['designer']}>
              <DesignerSelfView />
            </RequireRole>
          }
        />

        <Route path="*" element={<Navigate to={homePathFor(role)} replace />} />
      </Routes>
    </Suspense>
  )
}
