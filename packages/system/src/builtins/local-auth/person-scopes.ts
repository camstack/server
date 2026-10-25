/**
 * What `userManagement.setUserScopes` may store for a person (D921, amended
 * 2026-10-24): nothing (an admin) or exactly one viewer row. Any other row
 * is refused. There is no conversion of an older grant set (D900).
 */
import { userError, type UserScope } from '@camstack/types'

export function assertPersonScopes(scopes: readonly UserScope[]): void {
  if (scopes.length === 0) return
  const only = scopes[0]
  if (scopes.length === 1 && only !== undefined && only.type === 'viewer') return
  throw userError(
    'auth.person-scopes-refused',
    undefined,
    'A person is an admin, with no scope rows, or holds exactly one viewer grant',
  )
}
