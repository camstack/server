/**
 * A former standalone System page's route: lands on its tab of the System
 * page, keeping the query the old link carried (`/system/secrets?view=audit`).
 */
import { Navigate, useLocation } from 'react-router-dom'
import { type SystemTab, systemTabHref } from '../../lib/system-page-url'

export function SystemTabRedirect({ tab }: { readonly tab: SystemTab }) {
  const { search, hash } = useLocation()
  return <Navigate to={`${systemTabHref(tab, search)}${hash}`} replace />
}
