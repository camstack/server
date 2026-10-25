/**
 * Last-visited-location persistence — restores the operator's page after
 * login (and on app reopen at `/`) instead of always landing on the
 * dashboard.
 *
 * Stored per browser in localStorage. Only in-app paths are accepted;
 * auth/utility pages are excluded so a restore can never bounce back
 * into the login/rotation flow.
 */

const STORAGE_KEY = 'camstack:last-path'
const MAX_LENGTH = 512

/** Paths that must never be restored (auth + utility flows). */
const EXCLUDED_PREFIXES = ['/login', '/change-password', '/access-denied', '/logout'] as const

function isRestorablePath(path: string): boolean {
  if (!path.startsWith('/')) return false
  // Reject scheme-relative URLs ('//evil.host') — only in-app paths.
  if (path.startsWith('//')) return false
  if (path.length > MAX_LENGTH) return false
  return !EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'))
}

/** Persist the current in-app location (pathname + search). No-op for excluded paths. */
export function saveLastLocation(path: string): void {
  if (typeof window === 'undefined') return
  if (!isRestorablePath(path)) return
  try {
    window.localStorage.setItem(STORAGE_KEY, path)
  } catch {
    // Storage full/blocked — restoring is best-effort only.
  }
}

/** The last persisted in-app location, or null when absent/invalid. */
export function readLastLocation(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === null) return null
    return isRestorablePath(stored) ? stored : null
  } catch {
    return null
  }
}

const DEFAULT_LANDING = '/devices'

/**
 * Where a sign-in lands: the page ProtectedRoute interrupted (`state.from`)
 * when it is restorable, else the last visit, else the devices page.
 *
 * `from` goes through the same filter as a stored visit. A session that ended
 * ON the change-password page parks `/change-password` there, and restoring it
 * verbatim sent an operator who had just signed in with his NEW password back
 * to the rotation page — he changed it again and was signed out again.
 */
export function resolveLoginRestorePath(from: string | undefined): string {
  if (from !== undefined && isRestorablePath(from)) return from
  return readLastLocation() ?? DEFAULT_LANDING
}
