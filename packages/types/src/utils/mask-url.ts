/**
 * Names that, when used as URL query parameters, almost certainly carry
 * a secret. Matching is case-insensitive and anchored to the full param
 * name to avoid false positives like `user_id` (an entity reference, not
 * a credential) or `topic=password-reset` (a value happens to contain
 * the substring "password" but the param name is unrelated).
 *
 * Add new patterns here as we encounter cameras/APIs that leak through
 * the existing list.
 */
const CREDENTIAL_PARAM_PATTERNS: readonly RegExp[] = [
  /^user$/i,
  /^usr$/i,
  /^username$/i,
  /^password$/i,
  /^pwd$/i,
  /^pass$/i,
  /^passwd$/i,
  /^secret$/i,
  /^token$/i,
  /^auth$/i,
  /^auth[_-]?token$/i,
  /^bearer$/i,
  /^api[_-]?key$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  // One-time sign-in hand-offs: each is a bearer for the few minutes it lives
  // (the SSO login bridge, the OAuth authorization code and state, a login
  // challenge, a link claim / handoff code).
  /^bridge$/i,
  /^code$/i,
  /^state$/i,
  /^challenge$/i,
  // A native app's PKCE challenge on the app sign-in start (D858).
  /^code[_-]?challenge$/i,
  // The one-shot token of the app sign-in confirmation page (D858).
  /^confirm$/i,
  /^link$/i,
]

function isCredentialParam(name: string): boolean {
  return CREDENTIAL_PARAM_PATTERNS.some((re) => re.test(name))
}

/**
 * Redact secrets we may surface in logs or telemetry:
 *   1. `userinfo` (`user:password@host`) — the classic RTSP shape.
 *   2. Query-string credential params (`?user=...&password=...`) — the
 *      Reolink RTMP shape and several HTTP-pushed-stream APIs.
 *
 * Returns the original string verbatim when the input is not a parseable
 * URL — a log helper must never throw. Param values are replaced with
 * `***` so an operator reading logs still sees WHICH credential was
 * present (useful for debugging "wrong password" issues) without
 * exposing the value.
 *
 * The credential-name match is case-insensitive but anchored to the
 * whole param name; values like `user_id=42` or `topic=password-reset`
 * are NOT masked (those are entity references, not credentials).
 */
export function maskUrlCredentials(rawUrl: string): string {
  // A path with a query (`/api/auth/sso/finish?bridge=…`) is what request
  // logs carry; mask it against a throwaway base and give back a path.
  if (rawUrl.startsWith('/') && !rawUrl.startsWith('//')) {
    const masked = maskUrlCredentials(`http://relative.invalid${rawUrl}`)
    return masked.startsWith('http://relative.invalid')
      ? masked.slice('http://relative.invalid'.length)
      : rawUrl
  }
  try {
    const u = new URL(rawUrl)
    let touched = false

    if (u.username || u.password) {
      u.username = ''
      u.password = ''
      touched = true
    }

    for (const key of Array.from(u.searchParams.keys())) {
      if (isCredentialParam(key)) {
        u.searchParams.set(key, '***')
        touched = true
      }
    }

    return touched ? u.toString() : rawUrl
  } catch {
    return rawUrl
  }
}
