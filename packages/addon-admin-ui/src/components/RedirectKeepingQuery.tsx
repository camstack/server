/**
 * A redirect that carries the QUERY STRING across.
 *
 * The other redirects in `App.tsx` rewrite a path into a fixed `?tab=`, which
 * is the opposite problem. `/automation` moved to `/build` while its tab ids
 * stayed the same **on purpose**, so a bookmark to `?tab=scripts` must land on
 * the scripts section. A plain `<Navigate to="/build">` drops the query and
 * silently opens the default section instead — a redirect that "works" while
 * taking the operator somewhere else is the failure worth a component of its
 * own.
 */

import { Navigate, useLocation } from 'react-router-dom'

export interface RedirectKeepingQueryProps {
  /** Path to redirect to. The current search string is appended verbatim. */
  readonly to: string
}

export function RedirectKeepingQuery({ to }: RedirectKeepingQueryProps) {
  const { search } = useLocation()
  return <Navigate to={`${to}${search}`} replace />
}
