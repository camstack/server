import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Resolved deploy configuration. The credential is the `camstack login`
 * session and nothing else (D1101): no executor token, no `$CAMSTACK_TOKEN`,
 * no rc file. The address is the executor `server` option, `$CAMSTACK_SERVER`,
 * or the most recently used saved session's hub.
 *
 * This package is bootstrapped with plain `tsc` on a fresh clone, before nx can
 * run (see `ci.yml`), so it must not import `@camstack/develop` (whose build
 * needs `@camstack/types`, a vite build). It reads the session file itself, the
 * same `~/.camstack/<host>_<port>.json` the CLI writes. It does not renew an
 * expired session: any `camstack` command does, and this one says so.
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
  readonly createdAt?: number
}

const DEFAULT_PORT = '4443'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readSession(file: string): SavedSession | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isRecord(parsed)) return null
    const { server, token, expiresAt, lastUsedAt, createdAt } = parsed
    if (typeof server !== 'string' || typeof token !== 'string' || token === '') return null
    return {
      server,
      token,
      ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
      ...(typeof lastUsedAt === 'number' ? { lastUsedAt } : {}),
      ...(typeof createdAt === 'number' ? { createdAt } : {}),
    }
  } catch {
    return null
  }
}

/** `host[:port]` or an https URL → `{ url, slug }` as the CLI names the session file. */
function hubKey(input: string): { readonly url: string; readonly slug: string } {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`
  const u = new URL(withScheme)
  const port = u.port === '' ? DEFAULT_PORT : u.port
  return { url: `https://${u.hostname}:${port}`, slug: `${u.hostname}_${port}` }
}

function mostRecentSession(dir: string): SavedSession | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  let best: SavedSession | null = null
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const s = readSession(path.join(dir, name))
    if (s === null) continue
    const stamp = s.lastUsedAt ?? s.createdAt ?? 0
    if (best === null || stamp > (best.lastUsedAt ?? best.createdAt ?? 0)) best = s
  }
  return best
}

function notLoggedIn(server: string | undefined): Error {
  return new Error(
    `Not logged in to ${server ?? 'any hub'}. Run \`camstack login ${server ?? '<host>'}\` once, interactively: every tool uses that session.`,
  )
}

export function resolveDeployConfig(inputs: ResolveInputs): ResolvedDeployConfig {
  const env = inputs.env ?? process.env
  const dir = inputs.sessionDir ?? path.join(os.homedir(), '.camstack')
  const typed = inputs.server ?? env['CAMSTACK_SERVER']
  let session: SavedSession | null
  let target: string | undefined
  if (typed !== undefined && typed !== '') {
    const key = hubKey(typed)
    target = key.url
    session = readSession(path.join(dir, `${key.slug}.json`))
  } else {
    session = mostRecentSession(dir)
  }
  if (session === null) throw notLoggedIn(target)
  const now = inputs.now ?? Date.now()
  if (session.expiresAt !== undefined && session.expiresAt <= now) {
    throw new Error(
      `The saved session for ${session.server} has expired. Run any \`camstack\` command against it (it renews itself) or \`camstack login ${session.server}\`.`,
    )
  }
  return { server: (target ?? session.server).replace(/\/+$/, ''), token: session.token }
}
