import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/auth-context'
import { useTranslation } from 'react-i18next'

interface ProtectedRouteProps {
  children: React.ReactNode
  /**
   * When true, the route requires `isAdmin` on the JWT. Non-admin users
   * (including scoped-token callers) get redirected to /access-denied.
   * Omit for routes that any authenticated caller can access.
   */
  requireAdmin?: boolean
}

export function ProtectedRoute({ children, requireAdmin }: ProtectedRouteProps) {
  const { t } = useTranslation()
  const { user, loading, mustChangePassword } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground-subtle">
        {t('layouts.protectedRoute.loading', 'Loading...')}
      </div>
    )
  }

  if (!user) {
    // Carry the interrupted location so Login can return the operator to
    // the page they were on (session expiry / deep-link while logged out).
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  // Force password rotation before any authenticated route renders.
  // The rotate page itself lives outside ProtectedRoute (so this guard
  // doesn't loop) but `useAuth().user` is still required to know the
  // user id — see App.tsx for the route wiring.
  if (mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }

  if (requireAdmin && !user.isAdmin) {
    return <Navigate to="/access-denied" replace />
  }

  return <>{children}</>
}
