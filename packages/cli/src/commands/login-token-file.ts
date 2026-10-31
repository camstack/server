/**
 * `camstack login --token-file <path>` — the non-interactive login. The token
 * is read from a file only the owner can read; it is never an argv value or an
 * environment variable (those leak into process listings and child processes).
 * The hub validates it, then the session is cached exactly like the
 * interactive login (`~/.camstack/<host>.json`, 0600).
 */
import * as fs from 'node:fs'
import {
  jwtClaims,
  jwtExpiryMs,
  normalizeHubAddress,
  readTokenFile,
  saveSession,
  type SessionFile,
} from '@camstack/develop'
import { hubRequest } from '../http/hub-http.js'

const GROUP_OR_OTHER_BITS = 0o077

/** Refuse a token file that anyone but its owner can read. Windows has no such bits. */
export function assertPrivateTokenFile(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot read token file ${filePath}: ${reason}`, { cause: err })
  }
  if (!stat.isFile()) throw new Error(`Token file ${filePath} is not a regular file.`)
  if (platform !== 'win32' && (stat.mode & GROUP_OR_OTHER_BITS) !== 0) {
    const octal = (stat.mode & 0o777).toString(8)
    throw new Error(
      `Refusing token file ${filePath}: its mode is ${octal} and group/others can read it. ` +
        `Run \`chmod 600 ${filePath}\` (and consider the token exposed if others had access).`,
    )
  }
}

export interface TokenFileLoginOptions {
  readonly tokenFile: string
  /** The hub; falls back to the `server` of a session-format token file. */
  readonly server?: string
  readonly sessionDir?: string
  readonly platform?: NodeJS.Platform
}

export interface TokenFileLoginResult {
  readonly server: string
  readonly username: string
  readonly isAdmin: boolean
  readonly sessionFile: string
}

function usernameOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const name: unknown = Reflect.get(body, 'username')
  return typeof name === 'string' && name !== '' ? name : undefined
}

export async function loginWithTokenFile(
  opts: TokenFileLoginOptions,
): Promise<TokenFileLoginResult> {
  assertPrivateTokenFile(opts.tokenFile, opts.platform)
  const file = readTokenFile(opts.tokenFile)
  const typed = opts.server ?? file.server
  if (!typed) {
    throw new Error('login --token-file needs the hub: pass <host> or --server <host>.')
  }
  const server = normalizeHubAddress(typed)
  const res = await hubRequest(`${server}/api/auth/whoami`, {
    headers: { Authorization: `Bearer ${file.token}` },
    timeoutMs: 10_000,
    ...(opts.sessionDir ? { sessionDir: opts.sessionDir } : {}),
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `The hub ${server} rejected the token in ${opts.tokenFile} (revoked, expired or lacking scope).`,
    )
  }
  if (!res.ok) throw new Error(`The hub ${server} answered ${res.status} ${res.statusText}.`)
  const body: unknown = await res.json().catch(() => null)
  const claims = jwtClaims(file.token)
  const isAdmin = claims?.['isAdmin'] === true
  const username = usernameOf(body) ?? 'token'
  const expiresAt = jwtExpiryMs(file.token)
  const session: SessionFile = {
    server,
    username,
    tokenId: '',
    token: file.token,
    scopes: [],
    createdAt: Date.now(),
    ...(isAdmin ? { isAdmin: true } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
  const sessionFile = saveSession(session, opts.sessionDir)
  return { server, username, isAdmin, sessionFile }
}
