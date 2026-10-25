/**
 * Classify Wyze cloud-auth + P2P failures into operator-actionable kinds.
 * The lib's `login()` throws a `WyzeAuthError` (`{ needsMfa, mfaType }`)
 * for MFA accounts and plain `Error`s for everything else; rate-limit
 * lockouts surface as HTTP 429 / "too many" message text.
 */

export type WyzeErrorKind = 'mfa' | 'rate-limited' | 'credentials' | 'p2p' | 'unknown'

export interface ClassifiedWyzeError {
  readonly kind: WyzeErrorKind
  readonly message: string
}

function isWyzeAuthError(
  err: unknown,
): err is { message: string; needsMfa: boolean; mfaType?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'needsMfa' in err &&
    (err as { needsMfa: unknown }).needsMfa === true
  )
}

export function classifyCloudError(err: unknown): ClassifiedWyzeError {
  if (isWyzeAuthError(err)) {
    const mfaType = typeof err.mfaType === 'string' ? ` (${err.mfaType})` : ''
    return {
      kind: 'mfa',
      message: `Wyze account requires MFA${mfaType}. The bridge library has no MFA-completion flow — use a sub-account or disable MFA on this account.`,
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  if (lower.includes('429') || lower.includes('too many') || lower.includes('rate')) {
    return {
      kind: 'rate-limited',
      message: `Wyze auth is rate-limited (~1 request / 30s per IP). Retry later — the session is persisted and reused to avoid this. ${message}`,
    }
  }
  if (
    lower.includes('password') ||
    lower.includes('credential') ||
    lower.includes('login failed') ||
    lower.includes('access token') ||
    lower.includes('unauthorized')
  ) {
    return {
      kind: 'credentials',
      message: `Wyze login failed — check email / password / API key / Key ID. ${message}`,
    }
  }
  if (
    lower.includes('dtls') ||
    lower.includes('keyframe') ||
    lower.includes('p2p') ||
    lower.includes('discover') ||
    lower.includes('handshake') ||
    lower.includes('kauth')
  ) {
    return {
      kind: 'p2p',
      message: `Wyze P2P session failed (DTLS / discovery / keyframe). ${message}`,
    }
  }
  return { kind: 'unknown', message }
}
