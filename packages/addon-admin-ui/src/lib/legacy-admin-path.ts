/**
 * Admin-ui lives at the hub root (or its mount), never under `/admin`. Older
 * SSO returns and mailed links still point at `/admin/<route>`, which has no
 * route here and drew a blank page; map them onto the real route, keeping
 * the query and fragment.
 */
export function stripLegacyAdminPrefix(pathname: string): string {
  if (pathname === '/admin' || pathname === '/admin/') return '/'
  return pathname.startsWith('/admin/') ? pathname.slice('/admin'.length) : pathname
}
