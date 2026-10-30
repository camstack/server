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
import {
  type EchoDevice,
  type SessionStatus,
  type TargetDelivery,
  parseDeliveries,
  parseDevices,
  parseLoginResult,
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
}

export class BrokerEcho {
  private currentState: BrokerEchoState = 'starting'
  private currentError: string | null = null
  private currentDevices: readonly EchoDevice[] = []

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
      this.deps.logger.warn('alexa speak: device refresh failed', {
        tags: { brokerId: this.deps.brokerId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  async utter(
    op: 'speak' | 'announce',
    targets: readonly string[],
    text: string,
    volume: number,
  ): Promise<readonly TargetDelivery[]> {
    if (!(await this.ensureReady())) {
      throw new Error(this.notReadyReason())
    }
    return parseDeliveries(await this.deps.worker.request({ op, targets, text, volume }))
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
