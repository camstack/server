/**
 * The `camstack login` session cache — `~/.camstack/<host>.json` (0600), one
 * file per hub. Moved here from the CLI so every hub-talking tool (CLI,
 * `scripts/hub/hub.mjs`, the operator MCP) reads the SAME cache through the
 * SAME code. The cache holds the login JWT and its refresh token from `camstack login`,
 * never a password.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { normalizeHubAddress } from './hub-address.js'

export interface SessionFile {
  readonly server: string
  readonly username: string
  readonly tokenId: string
  readonly token: string
  readonly scopes: readonly { type: string; target: string }[]
  readonly createdAt: number
  /** Whether the logged-in user is a hub administrator (JWT sessions). */
  readonly isAdmin?: boolean
  /** Last time a command used this session (`touchSession`); absent on older files. */
  readonly lastUsedAt?: number
  /** The `csr_...` token that renews `token` (`auth.refreshSession`); absent on older files. */
  readonly refreshToken?: string
  /** When `token` expires (epoch ms); absent on older files (then the JWT `exp` is used). */
  readonly expiresAt?: number
}

/** Where the cache lives; injectable so a test never touches the real home. */
export function defaultSessionDir(): string {
  return path.join(os.homedir(), '.camstack')
}

/** Slug a server URL into a single filesystem-safe filename component. */
export function slugForServer(serverUrl: string): string {
  return serverUrl
    .replace(/^https?:\/\//, '')
    .replace(/[:/?#]+/g, '_')
    .replace(/_+$/, '')
}

export function sessionFileForServer(serverUrl: string, dir: string = defaultSessionDir()): string {
  return path.join(dir, `${slugForServer(serverUrl)}.json`)
}

/**
 * Resolve the right session file for the operator-supplied server URL.
 * With no server, fall back to the most recently touched session — an
 * operator typically works with one hub at a time.
 */
function resolveSessionFile(serverUrl: string | undefined, dir: string): string | null {
  if (serverUrl) {
    const p = sessionFileForServer(serverUrl, dir)
    return fs.existsSync(p) ? p : null
  }
  return defaultSessionFile(dir)
}

/** When a session was last used: `lastUsedAt`, else when it was created. */
export function sessionRecency(session: SessionFile): number {
  return session.lastUsedAt ?? session.createdAt
}

/**
 * Every readable saved session, most recently used first (ties: file mtime).
 * A corrupt or partial file is skipped, never fatal.
 */
export function listSessions(dir: string = defaultSessionDir()): readonly SessionFile[] {
  return listSessionEntries(dir).map((e) => e.session)
}

interface SessionEntry {
  readonly file: string
  readonly session: SessionFile
  readonly mtime: number
}

function listSessionEntries(dir: string): readonly SessionEntry[] {
  if (!fs.existsSync(dir)) return []
  const entries: SessionEntry[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (isSessionFile(parsed)) {
        entries.push({
          file,
          session: parsed,
          mtime: fs.statSync(file).mtimeMs,
        })
      }
    } catch {
      // an unreadable file is not a session
    }
  }
  return entries.toSorted(
    (a, b) => sessionRecency(b.session) - sessionRecency(a.session) || b.mtime - a.mtime,
  )
}

function defaultSessionFile(dir: string): string | null {
  return listSessionEntries(dir)[0]?.file ?? null
}

/**
 * THE default-session rule, used by every command that is given no server:
 *   1. the session of `$CAMSTACK_SERVER`, when one is set and saved;
 *   2. otherwise the most recently used session (`lastUsedAt`, else `createdAt`).
 */
export function defaultSession(
  sessions: readonly SessionFile[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): SessionFile | null {
  const named = env['CAMSTACK_SERVER']?.trim()
  if (named) {
    try {
      const server = normalizeHubAddress(named)
      const hit = sessions.find((s) => s.server === server)
      if (hit) return hit
    } catch {
      // a malformed $CAMSTACK_SERVER is reported by the command that resolves it
    }
  }
  return sessions.toSorted((a, b) => sessionRecency(b) - sessionRecency(a))[0] ?? null
}

/**
 * Shape check for a cached session blob. A partial or corrupted cache file
 * (e.g. after a crashed login) is treated as "no session" instead of crashing
 * a later `.slice` on undefined.
 */
export function isSessionFile(value: unknown): value is SessionFile {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.server !== 'string') return false
  if (typeof v.username !== 'string') return false
  if (typeof v.token !== 'string') return false
  if (typeof v.tokenId !== 'string') return false
  if (typeof v.createdAt !== 'number') return false
  if (!Array.isArray(v.scopes)) return false
  if (v.isAdmin !== undefined && typeof v.isAdmin !== 'boolean') return false
  if (v.refreshToken !== undefined && typeof v.refreshToken !== 'string') return false
  if (v.expiresAt !== undefined && typeof v.expiresAt !== 'number') return false
  return true
}

export function loadSession(
  serverUrl?: string,
  dir: string = defaultSessionDir(),
): SessionFile | null {
  const file = resolveSessionFile(serverUrl, dir)
  if (!file) return null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isSessionFile(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveSession(session: SessionFile, dir: string = defaultSessionDir()): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = sessionFileForServer(session.server, dir)
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 })
  return file
}

/** Record that a command just used this session; best effort, never throws. */
export function touchSession(
  serverUrl: string,
  dir: string = defaultSessionDir(),
  now: number = Date.now(),
): void {
  const session = loadSession(serverUrl, dir)
  if (!session) return
  try {
    saveSession({ ...session, lastUsedAt: now }, dir)
  } catch {
    // a read-only home must not fail the command that used the session
  }
}

export function clearSession(serverUrl: string, dir: string = defaultSessionDir()): boolean {
  const file = sessionFileForServer(serverUrl, dir)
  if (!fs.existsSync(file)) return false
  fs.unlinkSync(file)
  return true
}
