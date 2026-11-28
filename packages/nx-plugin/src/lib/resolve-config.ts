import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Resolved deploy configuration. The credential is the `dominevo login`
 * session and nothing else (D1101): no executor token, no `$CAMSTACK_TOKEN`,
 * no rc file. The address is the executor `server` option, `$CAMSTACK_SERVER`,
 * or the most recently used saved session's hub.
 *
 * This package is bootstrapped with plain `tsc` on a fresh clone, before nx can
 * run (see `ci.yml`), so it must not import `@dominevo/develop` (whose build
 * needs `@dominevo/types`, a vite build). It reads the session file itself, the
 * same `~/.camstack/<host>_<port>.json` the CLI writes. It does not renew an
 * expired session: any `camstack` command does, and this one says so.
 *
 * KEEP IN SYNC with develop, which owns the format:
 *   - `normalizeHub`    <- packages/develop/src/hub/hub-address.ts `normalizeHubAddress`
 *   - `slugForServer`   <- packages/develop/src/hub/session-store.ts `slugForServer`
 *   - `isSessionBlob`   <- session-store.ts `isSessionFile`
 *   - `jwtExpiry`       <- packages/develop/src/hub/credentials.ts `jwtExpiryMs`
 *   - ordering          <- session-store.ts `listSessionEntries` (recency, then mtime)
 * `__tests__/resolve-config.parity.spec.ts` imports develop in the TEST only and
 * compares each pair on a table of inputs.
 */
export interface ResolvedDeployConfig {
  readonly server: string
  readonly token: string
}

export interface ResolveInputs {
  readonly server?: string
  /** Override `process.env` for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Session directory (tests); defaults to `~/.camstack`. */
  readonly sessionDir?: string
  /** Clock (tests). */
  readonly now?: number
}

interface SavedSession {
  readonly server: string
  readonly token: string
  readonly expiresAt?: number
  readonly lastUsedAt?: number
  readonly createdAt: number
}

interface SessionEntry {
  readonly session: SavedSession
  readonly mtime: number
}

const DEFAULT_PORT = 4443

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isSessionBlob(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value['server'] !== 'string') return false
  if (typeof value['username'] !== 'string') return false
  if (typeof value['token'] !== 'string') return false
  if (typeof value['tokenId'] !== 'string') return false
  if (typeof value['createdAt'] !== 'number') return false
  if (!Array.isArray(value['scopes'])) return false
  if (value['isAdmin'] !== undefined && typeof value['isAdmin'] !== 'boolean') return false
  if (value['refreshToken'] !== undefined && typeof value['refreshToken'] !== 'string') return false
  if (value['expiresAt'] !== undefined && typeof value['expiresAt'] !== 'number') return false
  return true
}

function toSession(value: unknown): SavedSession | null {
  if (!isRecord(value) || !isSessionBlob(value)) return null
  const { server, token, createdAt, expiresAt, lastUsedAt } = value
  if (typeof server !== 'string' || typeof token !== 'string' || typeof createdAt !== 'number') {
    return null
  }
  return {
    server,
    token,
    createdAt,
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
    ...(typeof lastUsedAt === 'number' ? { lastUsedAt } : {}),
  }
}

function readEntry(file: string): SessionEntry | null {
  try {
    const session = toSession(JSON.parse(fs.readFileSync(file, 'utf8')))
    if (session === null) return null
    return { session, mtime: fs.statSync(file).mtimeMs }
  } catch {
    return null
  }
}

/** The JWT `exp` claim in ms, or undefined. */
export function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const raw = (parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
    const padded = raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), '=')
    const json: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    if (!isRecord(json) || Array.isArray(json)) return undefined
    const exp = json['exp']
    return typeof exp === 'number' ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

function parsePort(raw: string | undefined, input: string): number {
  if (raw === undefined) return DEFAULT_PORT
  const port = Number.parseInt(raw, 10)
  if (port < 1 || port > 65535) {
    throw new Error(`"${input}": port ${raw} is out of range (1-65535).`)
  }
  return port
}

/**
 * `https://<host>:<port>`: default port 4443, an explicit `:443` stays 443,
 * `http://` and other schemes refused.
 */
export function normalizeHub(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('The hub address is empty.')
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  if (scheme) {
    const name = (scheme[1] ?? '').toLowerCase()
    if (name === 'http') {
      throw new Error(
        `"${trimmed}": the hub API is https. Use https://<host>:${DEFAULT_PORT} (or just <host>).`,
      )
    }
    if (name !== 'https') {
      throw new Error(`"${trimmed}": unsupported scheme "${name}", the hub API is https.`)
    }
  }
  const rest = scheme ? trimmed.slice(scheme[0].length) : trimmed
  const authority = rest.split(/[/?#]/, 1)[0] ?? ''
  if (authority === '' || authority.includes('@')) {
    throw new Error(`"${trimmed}" is not a hub address (expected host[:port]).`)
  }
  let host: string
  let port: number
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority)
  if (bracketed) {
    host = `[${bracketed[1]}]`
    port = parsePort(bracketed[2], trimmed)
  } else if ((authority.match(/:/g) ?? []).length >= 2) {
    host = `[${authority}]`
    port = DEFAULT_PORT
  } else {
    const plain = /^([^:]+)(?::(\d+))?$/.exec(authority)
    if (!plain) throw new Error(`"${trimmed}" is not a hub address.`)
    host = plain[1] ?? ''
    port = parsePort(plain[2], trimmed)
  }
  let hostname: string
  try {
    hostname = new URL(`https://${host}`).hostname
  } catch {
    throw new Error(`"${trimmed}": "${host}" is not a valid host name or address.`)
  }
  return `https://${hostname}:${port}`
}

/** The session file's name for a server URL. */
export function slugForServer(serverUrl: string): string {
  return serverUrl
    .replace(/^https?:\/\//, '')
    .replace(/[:/?#]+/g, '_')
    .replace(/_+$/, '')
}

function mostRecentSession(dir: string): SavedSession | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const entries: SessionEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const e = readEntry(path.join(dir, name))
    if (e !== null) entries.push(e)
  }
  const recency = (e: SessionEntry): number => e.session.lastUsedAt ?? e.session.createdAt
  entries.sort((a, b) => recency(b) - recency(a) || b.mtime - a.mtime)
  return entries[0]?.session ?? null
}

function notLoggedIn(server: string | undefined): Error {
  return new Error(
    `Not logged in to ${server ?? 'any hub'}. Run \`dominevo login ${server ?? '<host>'}\` once, interactively: every tool uses that session.`,
  )
}

export function resolveDeployConfig(inputs: ResolveInputs): ResolvedDeployConfig {
  const env = inputs.env ?? process.env
  const dir = inputs.sessionDir ?? path.join(os.homedir(), '.camstack')
  const typed = inputs.server ?? env['CAMSTACK_SERVER']
  let session: SavedSession | null
  let target: string | undefined
  if (typed !== undefined && typed !== '') {
    target = normalizeHub(typed)
    session = readEntry(path.join(dir, `${slugForServer(target)}.json`))?.session ?? null
  } else {
    session = mostRecentSession(dir)
  }
  if (session === null) throw notLoggedIn(target)
  const now = inputs.now ?? Date.now()
  const expiresAt = session.expiresAt ?? jwtExpiry(session.token)
  if (expiresAt !== undefined && expiresAt <= now) {
    throw new Error(
      `The saved session for ${session.server} has expired. Run any \`camstack\` command against it (it renews itself) or \`dominevo login ${session.server}\`.`,
    )
  }
  return { server: (target ?? session.server).replace(/\/+$/, ''), token: session.token }
}
