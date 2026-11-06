/**
 * One broker's Echo session: its own Python worker, its own cookie jar and its
 * own device list. Signing in uses the broker's refresh token, so the operator
 * never types a second Amazon password; nothing here prompts for a code.
 */
import type { IScopedLogger } from '@camstack/types'
import type { EchoPushSink, PushChannelState } from './echo-push.js'
import { type BrokerSeed, regionOfDomain } from './broker-seed.js'
import type { SpeakSessionStore } from './session-store.js'
import { scrubSecrets, withSpeakSecretFiles } from './secret-file.js'
import type { AlexaWorker, WorkerRequestOptions } from './worker-client.js'
import { ECHO_RATE_BACKOFF_BASE_MS, ECHO_RATE_BACKOFF_MAX_MS } from './constants.js'
import {
  type DeviceVolume,
  type EchoDevice,
  type NpCommand,
  type PlayerInfo,
  RateLimitedError,
  type SessionStatus,
  type TargetDelivery,
  parseDeliveries,
  parseDevices,
  parseDeviceVolumes,
  parseDndState,
  parseLoginResult,
  parsePlayerState,
  parseSessionStatus,
  PUSH_IGNORED_COMMANDS,
  PUSH_READ_COMMANDS,
  type WorkerPush,
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
  /** Where the account's push channel is reported; without it the channel is not used. */
  readonly push?: EchoPushSink
}

function withDevice(deviceId: number | undefined): WorkerRequestOptions {
  return deviceId === undefined ? {} : { deviceId }
}

export class BrokerEcho {
  private currentState: BrokerEchoState = 'starting'
  private currentError: string | null = null
  private currentDevices: readonly EchoDevice[] = []
  private backoffMs = 0
  private limitedUntil = 0
  private channelState: PushChannelState = 'down'
  private channelWasUp = false
  private secrets: readonly string[] = []
  private readonly unknownPushLogged = new Set<string>()

  constructor(private readonly deps: BrokerEchoDeps) {
    deps.worker.onPush((push) => this.onPush(push))
  }

  /** Whether Amazon's push channel is open for this account right now. */
  get pushChannel(): PushChannelState {
    return this.channelState
  }

  /** A reason is text from the library: capped, then scrubbed of the secrets in play. */
  private safeReason(reason: string): string {
    return scrubSecrets(reason.slice(0, 200), this.secrets)
  }

  private onPush(push: WorkerPush): void {
    const tags = { tags: { brokerId: this.deps.brokerId } }
    if (push.push === 'channel') {
      if (push.state === this.channelState) {
        if (push.state === 'down') {
          this.deps.logger.debug('alexa echo: push channel still down', {
            ...tags,
            meta: { reason: this.safeReason(push.reason), retryInMs: push.retryInMs },
          })
        }
        return
      }
      this.channelState = push.state
      if (push.state === 'up') {
        this.deps.logger.info(
          this.channelWasUp
            ? 'alexa echo: push channel reconnected, polling slows down'
            : 'alexa echo: push channel connected, polling slows down',
          tags,
        )
        this.channelWasUp = true
      } else {
        this.deps.logger.warn('alexa echo: push channel down, polling at the normal pace', {
          ...tags,
          meta: { reason: this.safeReason(push.reason), retryInMs: push.retryInMs },
        })
      }
      this.deps.push?.channel(this.deps.brokerId, push.state)
      return
    }
    if (PUSH_READ_COMMANDS.has(push.command)) {
      if (push.serial === null) {
        this.deps.logger.debug('alexa echo: push event without an Echo, ignored', {
          ...tags,
          meta: { command: push.command },
        })
        return
      }
      this.deps.push?.event(this.deps.brokerId, push.serial)
      return
    }
    if (PUSH_IGNORED_COMMANDS.has(push.command)) return
    if (this.unknownPushLogged.has(push.command)) return
    this.unknownPushLogged.add(push.command)
    this.deps.logger.info('alexa echo: unknown push event, ignored (logged once)', {
      ...tags,
      meta: { command: push.command },
    })
  }

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
    // Do not rely on a down line arriving from a worker that is gone.
    if (this.channelState === 'up') {
      this.channelState = 'down'
      this.deps.push?.channel(this.deps.brokerId, 'down')
    }
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
      this.secrets = secrets
      let outcome = parseLoginResult({
        status: 'failed',
        error: 'worker gave no answer',
      })
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
  async playerState(serial: string, deviceType: string, deviceId?: number): Promise<PlayerInfo> {
    await this.requireReady()
    return this.limited(async () =>
      parsePlayerState(
        await this.deps.worker.request(
          { op: 'player_state', serial, deviceType },
          withDevice(deviceId),
        ),
      ),
    )
  }

  async npCommand(serial: string, command: NpCommand, deviceId?: number): Promise<void> {
    await this.requireReady()
    await this.limited(() =>
      this.deps.worker.request({ op: 'np_command', serial, command }, withDevice(deviceId)),
    )
  }

  async setVolume(serial: string, level: number, deviceId?: number): Promise<void> {
    await this.requireReady()
    await this.limited(() =>
      this.deps.worker.request({ op: 'set_volume', serial, level }, withDevice(deviceId)),
    )
  }

  /** Do Not Disturb of every device of the account, by serial, in one call. */
  async dndState(): Promise<ReadonlyMap<string, boolean>> {
    await this.requireReady()
    return this.limited(async () =>
      parseDndState(await this.deps.worker.request({ op: 'dnd_state' })),
    )
  }

  /** Speaker volume and mute of every device of the account, by serial, in one call. */
  async deviceVolumes(): Promise<ReadonlyMap<string, DeviceVolume>> {
    await this.requireReady()
    return this.limited(async () =>
      parseDeviceVolumes(await this.deps.worker.request({ op: 'device_volumes' })),
    )
  }

  async setDnd(serial: string, enabled: boolean, deviceId?: number): Promise<void> {
    await this.requireReady()
    await this.limited(() =>
      this.deps.worker.request({ op: 'set_dnd', serial, enabled }, withDevice(deviceId)),
    )
  }

  private async requireReady(): Promise<void> {
    if (!(await this.ensureReady())) throw new Error(this.notReadyReason())
  }

  async session(): Promise<SessionStatus> {
    if (this.deps.worker.failed) return { loggedIn: false, ageSec: 0, lastSuccessAt: null }
    try {
      return parseSessionStatus(await this.deps.worker.request({ op: 'session_status' }))
    } catch {
      return {
        loggedIn: this.currentState === 'ready',
        ageSec: 0,
        lastSuccessAt: null,
      }
    }
  }

  notReadyReason(): string {
    if (this.currentState === 'broker-not-signed-in') {
      return `account '${this.deps.brokerName}' is not signed in on its broker`
    }
    return this.currentError ?? 'alexa session is not ready'
  }
}
