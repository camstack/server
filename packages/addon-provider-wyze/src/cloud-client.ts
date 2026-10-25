/**
 * A single shared `WyzeCloud` per provider, with the session persisted to
 * `dataDir` so we `ensureSession` once and reuse it across restarts.
 *
 * Wyze rate-limits the auth endpoint (~1 req / 30 s per IP), so we MUST
 * persist + reuse the session and NEVER re-login per poll. The lib's
 * `ensureSession` uses the existing access token, else the refresh token,
 * else a full login; on a `getCameraList` token error it clears the
 * session via the injected `clearSession` callback so the next
 * `ensureSession` re-authenticates.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WyzeCloud } from '@apocaliss92/wyze-bridge-js'
import type { WyzeCamera, WyzeCloudSession, WyzeEvent } from '@apocaliss92/wyze-bridge-js'
import type { IScopedLogger } from '@camstack/types'

export interface WyzeCredentials {
  readonly email: string
  readonly password: string
  readonly apiKey: string
  readonly apiId: string
}

export interface WyzeCloudClientDeps {
  readonly dataDir: string
  readonly logger: IScopedLogger
  readonly credentials: WyzeCredentials
}

const SESSION_FILE = 'wyze-session.json'

/** Persist / load the cloud session as a JSON blob under `dataDir`. */
function loadSessionFromDisk(dataDir: string, logger: IScopedLogger): WyzeCloudSession | null {
  const path = join(dataDir, SESSION_FILE)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'accessToken' in parsed &&
      'refreshToken' in parsed
    ) {
      return parsed as WyzeCloudSession
    }
  } catch (err) {
    logger.warn('wyze cloud: failed to read persisted session — re-authenticating', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  }
  return null
}

function saveSessionToDisk(
  dataDir: string,
  session: WyzeCloudSession,
  logger: IScopedLogger,
): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, SESSION_FILE), JSON.stringify(session), 'utf8')
  } catch (err) {
    logger.warn('wyze cloud: failed to persist session', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  }
}

function clearSessionFromDisk(dataDir: string, logger: IScopedLogger): void {
  try {
    rmSync(join(dataDir, SESSION_FILE), { force: true })
  } catch (err) {
    logger.debug('wyze cloud: failed to clear session file', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  }
}

/**
 * Provider-scoped cloud client. Owns the single `WyzeCloud` instance and
 * a single-flight `ensureSession` guard so concurrent discovery / poll
 * calls never double-login (rate-limit safety).
 */
export class WyzeCloudClient {
  private readonly cloud: WyzeCloud
  private readonly deps: WyzeCloudClientDeps
  private ensureInFlight: Promise<void> | null = null

  constructor(deps: WyzeCloudClientDeps) {
    this.deps = deps
    this.cloud = new WyzeCloud({
      apiKey: deps.credentials.apiKey,
      apiId: deps.credentials.apiId,
      loadSession: () => loadSessionFromDisk(deps.dataDir, deps.logger),
      saveSession: (s) => saveSessionToDisk(deps.dataDir, s, deps.logger),
      clearSession: () => clearSessionFromDisk(deps.dataDir, deps.logger),
    })
  }

  /**
   * Ensure a valid session, single-flighted. Surfaces MFA + rate-limit
   * errors verbatim so the caller can classify them (`classifyCloudError`).
   */
  async ensureSession(): Promise<void> {
    if (this.ensureInFlight) return this.ensureInFlight
    const run = this.cloud
      .ensureSession(this.deps.credentials.email, this.deps.credentials.password)
      .finally(() => {
        this.ensureInFlight = null
      })
    this.ensureInFlight = run
    return run
  }

  async getCameraList(): Promise<readonly WyzeCamera[]> {
    await this.ensureSession()
    return this.cloud.getCameraList()
  }

  async getEventList(options: {
    macs?: readonly string[]
    beginTime?: number
    endTime?: number
    count?: number
  }): Promise<readonly WyzeEvent[]> {
    await this.ensureSession()
    return this.cloud.getEventList({
      ...(options.macs ? { macs: [...options.macs] } : {}),
      ...(options.beginTime !== undefined ? { beginTime: options.beginTime } : {}),
      ...(options.endTime !== undefined ? { endTime: options.endTime } : {}),
      ...(options.count !== undefined ? { count: options.count } : {}),
    })
  }

  /** Access token for downloading event thumbnail files. */
  getAccessToken(): string | null {
    return this.cloud.getAccessToken()
  }
}
