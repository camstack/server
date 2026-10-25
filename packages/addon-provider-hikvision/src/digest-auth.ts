import { createHash, randomBytes } from 'node:crypto'

/**
 * Minimal HTTP Digest Auth client (RFC 7616, MD5 + qop=auth) — sized
 * for the Hikvision ISAPI surface, NOT a general-purpose auth client.
 * Hikvision cameras advertise `Digest realm=..., nonce=..., qop=auth`
 * in their `WWW-Authenticate` header; SHA-256 / sess variants and
 * Basic fallback are rare in the wild and intentionally unsupported
 * to keep this file under 100 lines.
 *
 * Usage pattern (callers should reuse the returned `DigestState` for
 * the lifetime of a logical session — `nonce`/`opaque` are per-realm
 * and must be remembered across requests; the per-request `nc`
 * counter is the only mutable bit):
 *
 *   const state: DigestState = { nc: 0 }
 *   // first request — no Authorization header → server returns 401 +
 *   // Authenticate; absorb it and retry
 *   const auth = buildAuthHeader({state, method: 'GET', uri: '/ISAPI/...',
 *     username, password, challenge})
 *
 * The `challenge` is parsed once per 401 via `parseChallenge`. Stale
 * nonces (`stale=true`) trigger a fresh challenge automatically — the
 * caller absorbs the new 401 and retries.
 */

export interface DigestChallenge {
  readonly realm: string
  readonly nonce: string
  readonly qop: string | null
  readonly opaque: string | null
  readonly algorithm: string | null
  readonly stale: boolean
}

export interface DigestState {
  /** Monotonically incremented per request — formatted as 8-hex
   *  (`00000001`) and folded into the response hash. */
  nc: number
  /** Last-seen challenge. Reused for subsequent requests against the
   *  same realm so we don't trigger a 401 on every call. */
  challenge?: DigestChallenge
}

/**
 * Parse a `WWW-Authenticate: Digest ...` header. Returns null when the
 * header is absent or not a Digest scheme — caller falls back to a
 * basic 401 (i.e. credentials wrong).
 */
export function parseChallenge(headerValue: string | null): DigestChallenge | null {
  if (!headerValue) return null
  // Strip leading scheme token (case-insensitive). Older Hikvision
  // firmwares prepend extra whitespace + a stray comma — the leading
  // `^\s*Digest\s+` match handles both.
  const stripped = headerValue.replace(/^\s*Digest\s+/i, '')
  if (stripped === headerValue) return null

  // Tokens are `key=value` with value optionally quoted. Hikvision
  // doesn't escape quotes, so a non-greedy quoted match is safe.
  const tokens: Record<string, string> = {}
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const k = m[1]!.toLowerCase()
    const v = (m[2] ?? m[3] ?? '').trim()
    tokens[k] = v
  }
  if (!tokens['realm'] || !tokens['nonce']) return null
  return {
    realm: tokens['realm']!,
    nonce: tokens['nonce']!,
    qop: tokens['qop'] ?? null,
    opaque: tokens['opaque'] ?? null,
    algorithm: tokens['algorithm'] ?? null,
    stale: tokens['stale']?.toLowerCase() === 'true',
  }
}

const md5 = (input: string): string => createHash('md5').update(input).digest('hex')

/**
 * Build the `Authorization: Digest ...` header value for one request.
 * Mutates `state.nc` (incremented). Returns `null` when no challenge
 * has been seen yet — the caller should send the request without an
 * Authorization header and absorb the 401 + Authenticate response.
 */
export function buildAuthHeader(input: {
  readonly state: DigestState
  readonly method: string
  readonly uri: string
  readonly username: string
  readonly password: string
}): string | null {
  const ch = input.state.challenge
  if (!ch) return null
  const nc = (++input.state.nc).toString(16).padStart(8, '0')
  const cnonce = randomBytes(8).toString('hex')
  const ha1 = md5(`${input.username}:${ch.realm}:${input.password}`)
  const ha2 = md5(`${input.method}:${input.uri}`)
  const qop =
    ch.qop
      ?.split(',')
      .map((s) => s.trim())
      .find((s) => s === 'auth') ?? null
  const response = qop
    ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${ch.nonce}:${ha2}`)

  const parts: string[] = [
    `username="${input.username}"`,
    `realm="${ch.realm}"`,
    `nonce="${ch.nonce}"`,
    `uri="${input.uri}"`,
    `response="${response}"`,
  ]
  if (qop) {
    parts.push(`qop=${qop}`)
    parts.push(`nc=${nc}`)
    parts.push(`cnonce="${cnonce}"`)
  }
  if (ch.algorithm) parts.push(`algorithm=${ch.algorithm}`)
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`)
  return `Digest ${parts.join(', ')}`
}
