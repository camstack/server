/**
 * Credential resolution shared by every hub-talking tool: the CLI commands
 * (`deploy`, `dev`, `watch`, `mcp` ...), `scripts/hub/hub.mjs` and the MCP
 * servers. One mechanism, no copy (D1101, which retires the D835 overrides).
 *
 * A client reaches a hub in exactly ONE way: the `camstack login` session
 * cached in `~/.camstack/<host>_<port>.json` (0600), renewed unattended by
 * `session-refresh.ts`. There is no flag, no token file and no environment
 * variable that carries a credential. A headless service logs in once, then
 * the session refreshes itself.
 *
 * Server precedence (an ADDRESS, never a credential): `--server`,
 * `$CAMSTACK_SERVER`, the cached session's `server`. The caller applies its
 * own default when none of these is set.
 */
import { normalizeHubAddress } from './hub-address.js'

/** Where a credential came from. The login session is the only source. */
export type CredentialSource = 'session'

/** What a credential may reach locally before the hub validates every call. */
export type CredentialTier = 'admin' | 'protected'

export interface CredentialTierOptions {
  /** When the token came from a cached session file that recorded admin role. */
  readonly sessionIsAdmin?: boolean
}

/** The claims of a JWT, without a signature check; `null` when `token` is not a JWT. */
export function jwtClaims(token: string): Readonly<Record<string, unknown>> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const raw = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), '=')
    const json: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
    return Object.fromEntries(Object.entries(json))
  } catch {
    return null
  }
}

/** Decode a JWT payload for a local tier hint; no signature check. */
export function jwtPayloadIsAdmin(token: string): boolean {
  return jwtClaims(token)?.['isAdmin'] === true
}

/** When a JWT expires (epoch ms), or `undefined` for a token with no `exp` claim. */
export function jwtExpiryMs(token: string): number | undefined {
  const exp = jwtClaims(token)?.['exp']
  return typeof exp === 'number' ? exp * 1000 : undefined
}

/**
 * The tier a token buys locally, from its CLAIMS only (or the session's recorded
 * role). A token with no readable claims is `protected` here; the async resolver
 * asks the hub (`whoami`) before settling on that. The hub still decides on every call.
 */
export function credentialTier(token: string, opts?: CredentialTierOptions): CredentialTier {
  if (opts?.sessionIsAdmin === true) return 'admin'
  return jwtPayloadIsAdmin(token) ? 'admin' : 'protected'
}

export interface ResolvedCredentials {
  readonly server: string | undefined
  readonly token: string
  readonly source: CredentialSource
  readonly tier: CredentialTier
  /** Set when the tier came from a hub lookup that FAILED: `tier` is then only a floor, not an answer. */
  readonly tierLookupFailure?: string
}

export interface CachedSessionLike {
  readonly server: string
  readonly token: string
  /** Copied from `camstack login` when the hub reported an admin user. */
  readonly isAdmin?: boolean
  /** The `csr_...` token that renews the session; absent on older files. */
  readonly refreshToken?: string
  /** When `token` expires (epoch ms); absent on older files (then the JWT `exp`). */
  readonly expiresAt?: number
}

export interface CredentialInputs {
  readonly server?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The session lookup — `loadSession` from `auth.ts`, injectable for tests. */
  readonly loadSession: (server?: string) => CachedSessionLike | null
}

/** No token could be resolved from any source. The message tells the operator what to do. */
export class MissingCredentialsError extends Error {
  constructor(server: string | undefined, reason?: string) {
    super(
      [
        reason ? `${reason} (${server ?? 'any hub'}).` : `Not logged in to ${server ?? 'any hub'}.`,
        `  Run \`camstack login ${server ?? '<host>'}\` once, interactively: every tool uses that session`,
        '  and the saved session renews itself, so a headless service is logged in once.',
      ].join('\n'),
    )
    this.name = 'MissingCredentialsError'
  }
}

/** Resolve `{server, token}` for a hub command. Throws {@link MissingCredentialsError}. */
export function resolveCredentials(inputs: CredentialInputs): ResolvedCredentials {
  const env = inputs.env ?? process.env
  const typed = inputs.server ?? env['CAMSTACK_SERVER']
  const targeted = typed ? normalizeHubAddress(typed) : undefined
  const session = inputs.loadSession(targeted)
  const server = targeted ?? session?.server
  if (!session) throw new MissingCredentialsError(server)
  const tier = credentialTier(session.token, {
    ...(session.isAdmin === true ? { sessionIsAdmin: true } : {}),
  })
  return { server, token: session.token, source: 'session', tier }
}

const REJECTION_ADVICE: Readonly<Record<CredentialSource, string>> = {
  session:
    'The hub rejected the cached session (revoked or expired). Run `camstack login <host>` again.',
}

/**
 * The line to append to an HTTP failure when it was an auth rejection,
 * or `null` for any other status.
 */
export function authRejectedHint(status: number, source: CredentialSource): string | null {
  if (status !== 401 && status !== 403) return null
  return REJECTION_ADVICE[source]
}

/** `message`, plus the {@link authRejectedHint} on its own line when one applies. */
export function withAuthHint(
  message: string,
  status: number,
  source: CredentialSource | undefined,
): string {
  const hint = source ? authRejectedHint(status, source) : null
  return hint ? `${message}\n  ${hint}` : message
}
