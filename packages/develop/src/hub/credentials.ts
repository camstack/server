/**
 * Credential resolution shared by every hub-talking tool: the CLI commands
 * (`deploy`, `deploy-server`, `dev`, `watch`), `scripts/hub/hub.mjs` and the
 * private operator MCP (`@camstack/mcp-dev`). One chain, no copy (D835).
 *
 * `camstack login` caches the login JWT in `~/.camstack/<host>.json` (0600);
 * every command picks that session up on its own, so a terminal that ran
 * `login` once needs no further flags.
 *
 * ONE token format; only the SET OF PERMISSIONS differs (admin = everything).
 * Nothing here looks for a specific token file or prefix.
 *
 * Token precedence (first hit wins):
 *   1. `--token <token>`        - explicit one-off
 *   2. `--token-file <path>`    - an explicit override: a bare token, or a session
 *                                 file in the `~/.camstack/<host>.json` format
 *   3. `$CAMSTACK_TOKEN`        - still read by the CLI; ops tools pass an env
 *                                 without it (no secret through the environment)
 *   4. the cached session       - `camstack login`, refreshed automatically
 *                                 (`session-refresh.ts`)
 *
 * A password is never an input: nothing here logs in.
 *
 * Server precedence: `--server`, `$CAMSTACK_SERVER`, the token file's
 * `server` (session-format files only), the cached session's `server`.
 * The caller applies its own default when none of these is set.
 */
import * as fs from 'node:fs'
import { normalizeHubAddress } from './hub-address.js'

export type CredentialSource = 'flag' | 'token-file' | 'env' | 'session'

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
  /** A non-fatal note for stderr (e.g. a world-readable token file). */
  readonly warning?: string
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
  readonly token?: string
  readonly tokenFile?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The session lookup — `loadSession` from `auth.ts`, injectable for tests. */
  readonly loadSession: (server?: string) => CachedSessionLike | null
}

export interface TokenFileContents {
  readonly token: string
  readonly server?: string
  readonly warning?: string
}

/** No token could be resolved from any source. The message tells the operator what to do. */
export class MissingCredentialsError extends Error {
  constructor(server: string | undefined, reason?: string) {
    super(
      [
        reason ? `${reason} (${server ?? 'any hub'}).` : `Not logged in to ${server ?? 'any hub'}.`,
        `  Run \`camstack login ${server ?? '<host>'}\` once: every tool uses that session`,
        '  (~/.camstack/<host>.json, refreshed automatically). --token-file is an explicit',
        '  override only, for a token you were handed.',
      ].join('\n'),
    )
    this.name = 'MissingCredentialsError'
  }
}

const GROUP_OR_OTHER_BITS = 0o077

/**
 * Read a token file: a single bare token, or a JSON session file
 * (`{ "server": "...", "token": "..." }`, extra fields ignored).
 */
export function readTokenFile(filePath: string): TokenFileContents {
  let raw: string
  let mode: number
  try {
    raw = fs.readFileSync(filePath, 'utf8')
    mode = fs.statSync(filePath).mode
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot read token file ${filePath}: ${reason}`, {
      cause: err,
    })
  }
  const warning =
    process.platform !== 'win32' && (mode & GROUP_OR_OTHER_BITS) !== 0
      ? `Token file ${filePath} is readable by other users — run \`chmod 600 ${filePath}\`.`
      : undefined
  const parsed = parseTokenFile(raw.trim(), filePath)
  return warning ? { ...parsed, warning } : parsed
}

function parseTokenFile(content: string, filePath: string): TokenFileContents {
  if (content.length === 0) throw new Error(`Token file ${filePath} is empty.`)
  if (content.startsWith('{')) return parseSessionJson(content, filePath)
  if (/\s/.test(content)) {
    throw new Error(`Token file ${filePath} must hold exactly one token (found several lines).`)
  }
  return { token: content }
}

function parseSessionJson(content: string, filePath: string): TokenFileContents {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    throw new Error(`Token file ${filePath} looks like JSON but does not parse.`)
  }
  if (json === null || typeof json !== 'object') {
    throw new Error(`Token file ${filePath}: expected a JSON object with a "token" field.`)
  }
  const token: unknown = Reflect.get(json, 'token')
  const server: unknown = Reflect.get(json, 'server')
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`Token file ${filePath}: the JSON has no string "token" field.`)
  }
  return typeof server === 'string' && server.length > 0 ? { token, server } : { token }
}

interface PickedToken {
  readonly token: string
  readonly source: CredentialSource
  readonly sessionIsAdmin?: boolean
}

/** Resolve `{server, token}` for a hub command. Throws {@link MissingCredentialsError}. */
export function resolveCredentials(inputs: CredentialInputs): ResolvedCredentials {
  const env = inputs.env ?? process.env
  const file = inputs.tokenFile ? readTokenFile(inputs.tokenFile) : null
  const typed = inputs.server ?? env['CAMSTACK_SERVER']
  const targeted = typed ? normalizeHubAddress(typed) : file?.server
  const session = inputs.loadSession(targeted)
  const server = targeted ?? session?.server
  const picked = pickToken(inputs.token, file, env['CAMSTACK_TOKEN'], session)
  if (!picked) throw new MissingCredentialsError(server)
  const warning = file?.warning
  const tier = credentialTier(picked.token, {
    ...(picked.sessionIsAdmin === true ? { sessionIsAdmin: true } : {}),
  })
  return warning ? { server, ...picked, tier, warning } : { server, ...picked, tier }
}

function pickToken(
  flag: string | undefined,
  file: TokenFileContents | null,
  envToken: string | undefined,
  session: CachedSessionLike | null,
): PickedToken | null {
  if (flag) return { token: flag, source: 'flag' }
  if (file) return { token: file.token, source: 'token-file' }
  if (envToken) return { token: envToken, source: 'env' }
  if (session) {
    return {
      token: session.token,
      source: 'session',
      ...(session.isAdmin === true ? { sessionIsAdmin: true } : {}),
    }
  }
  return null
}

const REJECTION_ADVICE: Readonly<Record<CredentialSource, string>> = {
  session: 'The hub rejected the cached session (revoked or expired). Run `camstack login` again.',
  'token-file':
    'The hub rejected the token from the token file (revoked, expired or lacking scope) — ask the operator who issued it for a new one.',
  env: 'The hub rejected $CAMSTACK_TOKEN (revoked, expired or lacking scope).',
  flag: 'The hub rejected the --token value (revoked, expired or lacking scope).',
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
