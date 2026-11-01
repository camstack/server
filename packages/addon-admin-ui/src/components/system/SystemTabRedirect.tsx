/**
 * A former standalone System page's route: lands on its tab of the System
 * page, keeping the query the old link carried.
 */
import { Navigate, useLocation } from 'react-router-dom'
import { type SystemTab, secretsTabHref, systemTabHref } from '../../lib/system-page-url'

export function SystemTabRedirect({ tab }: { readonly tab: SystemTab }) {
  const { search, hash } = useLocation()
  return <Navigate to={`${systemTabHref(tab, search)}${hash}`} replace />
}

/** The former `/system/secrets` route: Secrets is now a tab of Data. */
export function SecretsTabRedirect() {
  const { search, hash } = useLocation()
  return <Navigate to={`${secretsTabHref(search)}${hash}`} replace />
}
