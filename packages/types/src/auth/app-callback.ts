/**
 * The viewer app's custom-scheme callback — the ONE list of URLs a hub flow
 * may hand a browser back to the native app at.
 *
 * Two readers, one answer: the admin-ui login page (`redirect=` for the
 * native sign-in handoff) and the hub itself (`auth.beginExternalLink`'s
 * `returnTo` for a native account link, D801). Both validate against this
 * list, so a scheme added for one flow can never be accepted by one side and
 * refused by the other.
 *
 * `camstack` is the production app; `camstack.dev` the dev client
 * (`APP_VARIANT=development`). Exact match after canonicalisation — no
 * query or fragment riders, no http(s).
 */
export const APP_AUTH_CALLBACK_URLS: readonly string[] = [
  'camstack://auth-callback',
  'camstack.dev://auth-callback',
]

/** Longest raw callback value considered at all. */
export const APP_AUTH_CALLBACK_MAX_LENGTH = 512

/**
 * The variants the OS / linking layer produces for the same callback:
 * `scheme:///auth-callback` (expo-linking's empty-host standalone form — three
 * slashes) and a trailing `/` both mean `scheme://auth-callback`. Nothing else
 * is normalised: riders keep failing the exact match.
 */
export function canonicalizeAppCallback(raw: string): string {
  return raw.replace(/^([a-z][a-z0-9.+-]*):\/\/\/(?!\/)/i, '$1://').replace(/\/$/, '')
}

/** The canonical allowlisted callback `raw` names, or `null`. */
export function parseAppAuthCallback(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > APP_AUTH_CALLBACK_MAX_LENGTH)
    return null
  const canonical = canonicalizeAppCallback(raw)
  return APP_AUTH_CALLBACK_URLS.includes(canonical) ? canonical : null
}

/** True for a URL with a scheme (`camstack://…`, `https://…`) — not a hub-relative path. */
export function hasUrlScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url)
}
