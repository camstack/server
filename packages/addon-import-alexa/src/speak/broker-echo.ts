/**
 * One broker's Echo session: its own Python worker, its own cookie jar and its
 * own device list. Signing in uses the broker's refresh token, so the operator
 * never types a second Amazon password; nothing here prompts for a code.
 */
import type { IScopedLogger } from '@camstack/types'
import { type BrokerSeed, regionOfDomain } from './broker-seed.js'
import type { SpeakSessionStore } from './session-store.js'
import { scrubSecrets, withSpeakSecretFiles } from './secret-file.js'
import type { AlexaWorker } from './worker-client.js'
import { ECHO_RATE_BACKOFF_BASE_MS, ECHO_RATE_BACKOFF_MAX_MS } from './constants.js'
import {
  type EchoDevice,
  type NpCommand,
  type PlayerInfo,
  RateLimitedError,
  type SessionStatus,
  type TargetDelivery,
  parseDeliveries,
  parseDevices,
  parseDndState,
  parseLoginResult,
  parsePlayerState,
  parseSessionStatus,
} from './worker-protocol.js'

/**
 * `broker-not-signed-in`: the broker holds no refresh token and no jar is stored.
 * The operator signs in once on the broker (Integrations, Alexa), not here.
 */
export type BrokerEchoState = 'starting' | 'ready' | 'broker-not-signed-in' | 'failed'

export interface BrokerEchoDeps {
  readonly brokerId: string
  readonly brokerName: string
  readonly domain: string
  readonly worker: AlexaWorker
  readonly readSeed: () => Promise<BrokerSeed | null>
  readonly sessions: SpeakSessionStore
  readonly logger: IScopedLogger
  readonly now?: () => number
}

export class BrokerEcho {
  private currentState: BrokerEchoState = 'starting'
  private currentError: string | null = null
  private currentDevices: readonly EchoDevice[] = []
  private backoffMs = 0
  private limitedUntil = 0

  constructor(private readonly deps: BrokerEchoDeps) {}

  get id(): string {
    return this.deps.brokerId
  }

  get name(): string {
    return this.deps.brokerName
  }

  get state(): BrokerEchoState {
    return this.currentState
  }

  get error(): string | null {
    return this.currentError
  }

  get devices(): readonly EchoDevice[] {
    return this.currentDevices
  }

  /** Ms epoch until which Amazon asked us to wait (429), or null when the account is free. */
  get rateLimitedUntil(): number | null {
    return this.limitedUntil > this.nowMs() ? this.limitedUntil : null
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)()
  }

  stop(): void {
    this.deps.worker.stop()
  }

  /** Sign the worker in as the broker's account. Never throws; the outcome is `state`. */
  async signIn(): Promise<void> {
    const { brokerId, worker, sessions, logger } = this.deps
    const tags = { tags: { brokerId } }
    let secrets: readonly string[] = []
    try {
      const seed = await this.deps.readSeed()
      const stored = await sessions.get(brokerId)
      logger.info('alexa speak: broker sign-in material', {
        ...tags,
        meta: {
          seedFound: seed !== null,
          hasRefreshToken: seed !== null && seed.refreshToken.length > 0,
          hasDeviceAppName: seed !== null && seed.deviceAppName.length > 0,
          hasStoredSession: stored.length > 0,
        },
      })
      if (seed === null && stored.length === 0) {
        this.currentState = 'broker-not-signed-in'
        this.currentError = null
        logger.warn('alexa speak: the broker has no sign-in to share yet', tags)
        return
      }
      secrets = seed === null ? [] : [seed.refreshToken]
      worker.noteSecrets(secrets)
      let outcome = parseLoginResult({ status: 'failed', error: 'worker gave no answer' })
      const held = await withSpeakSecretFiles(
        { refreshToken: seed?.refreshToken ?? '', sessionB64: stored },
        async (paths) => {
          outcome = parseLoginResult(
            await worker.request({
              op: 'login_broker',
              label: brokerId,
              refreshTokenPath: seed === null ? '' : paths.refreshTokenPath,
              deviceAppName: seed?.deviceAppName ?? '',
              domain: this.deps.domain,
              sessionPath: paths.sessionPath,
              region: regionOfDomain(this.deps.domain),
            }),
          )
        },
      )
      if (held.sessionB64.length > 0 && held.sessionB64 !== stored) {
        await sessions.put(brokerId, held.sessionB64)
      }
      this.currentError = outcome.status === 'ok' ? null : (outcome.error ?? 'sign-in failed')
      this.currentState = outcome.status === 'ok' ? 'ready' : 'failed'
      if (outcome.status !== 'ok') {
        logger.warn('alexa speak: sign-in as the broker failed', {
          ...tags,
          meta: { error: this.currentError },
        })
        return
      }
      await this.refreshDevices()
    } catch (err: unknown) {
      this.currentState = 'failed'
      this.currentError = scrubSecrets(err instanceof Error ? err.message : String(err), secrets)
      logger.warn('alexa speak: sign-in as the broker failed', {
        ...tags,
        meta: { error: this.currentError },
      })
    }
  }

  /** A session that is not ready tries to sign in again before it gives up. */
  async ensureReady(): Promise<boolean> {
    if (this.currentState !== 'ready') await this.signIn()
    return this.currentState === 'ready'
  }

  async refreshDevices(): Promise<void> {
    if (this.currentState !== 'ready') return
    try {
      this.currentDevices = [...parseDevices(await this.deps.worker.request({ op: 'devices' }))]
    } catch (err: unknown) {
      this.deps.logger.warn('alexa speak: step 3 of 3, device list failed after a good sign-in', {
        tags: { brokerId: this.deps.brokerId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  async utter(
    op: 'speak' | 'announce',
    targets: readonly string[],
    text: string,
  ): Promise<readonly TargetDelivery[]> {
    if (!(await this.ensureReady())) {
      throw new Error(this.notReadyReason())
    }
    return parseDeliveries(await this.deps.worker.request({ op, targets, text }))
  }

  /**
   * Run one worker call. A 429 starts (or doubles) the account's back-off and is
   * rethrown as is; any answer ends it. Rate limiting is a status, not a failure.
   */
  private async limited<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call()
      this.backoffMs = 0
      this.limitedUntil = 0
      return result
    } catch (err: unknown) {
      if (err instanceof RateLimitedError) {
        this.backoffMs =
          this.backoffMs === 0
            ? ECHO_RATE_BACKOFF_BASE_MS
            : Math.min(this.backoffMs * 2, ECHO_RATE_BACKOFF_MAX_MS)
        this.limitedUntil = this.nowMs() + this.backoffMs
        this.deps.logger.info('alexa echo: amazon asked for a pause (429)', {
          tags: { brokerId: this.deps.brokerId },
          meta: { backoffMs: this.backoffMs },
        })
      }
      throw err
    }
  }

  /** The raw player state of one Echo. Throws on any failure, a 429 included: never an empty answer. */
  async playerState(serial: string, deviceType: string): Promise<PlayerInfo> {
    await this.requireReady()
    return this.limited(async () =>
      parsePlayerState(
        await this.deps.worker.request({
          op: 'player_state',
          serial,
          deviceType,
        }),
      ),
    )
  }

  async npCommand(serial: string, command: NpCommand): Promise<void> {
    await this.requireReady()
    await this.limited(() => this.deps.worker.request({ op: 'np_command', serial, command }))
  }

  async setVolume(serial: string, level: number): Promise<void> {
    await this.requireReady()
    await this.limited(() => this.deps.worker.request({ op: 'set_volume', serial, level }))
  }

  /** Do Not Disturb of every device of the account, by serial, in one call. */
  async dndState(): Promise<ReadonlyMap<string, boolean>> {
    await this.requireReady()
    return this.limited(async () =>
      parseDndState(await this.deps.worker.request({ op: 'dnd_state' })),
    )
  }

  async setDnd(serial: string, enabled: boolean): Promise<void> {
    await this.requireReady()
    await this.limited(() => this.deps.worker.request({ op: 'set_dnd', serial, enabled }))
  }

  private async requireReady(): Promise<void> {
    if (!(await this.ensureReady())) throw new Error(this.notReadyReason())
  }

  async session(): Promise<SessionStatus> {
    if (this.deps.worker.failed) return { loggedIn: false, ageSec: 0, lastSuccessAt: null }
    try {
      return parseSessionStatus(await this.deps.worker.request({ op: 'session_status' }))
    } catch {
      return { loggedIn: this.currentState === 'ready', ageSec: 0, lastSuccessAt: null }
    }
  }

  notReadyReason(): string {
    if (this.currentState === 'broker-not-signed-in') {
      return `account '${this.deps.brokerName}' is not signed in on its broker`
    }
    return this.currentError ?? 'alexa session is not ready'
  }
}
