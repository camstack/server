/**
 * Echo speech for every Amazon account the addon already imports from. Each
 * broker gets its own Python worker, cookie jar and Echo list, all signed in
 * with the broker's own refresh token: the operator signs in once, on the
 * broker, and never again here.
 */
import type { IScopedLogger, Target } from '@camstack/types'
import type { z } from 'zod'
import type { AlexaSpeakSettings } from '../config.js'
import { readSpeakSettings } from '../config.js'
import { alexaSpeakActions, type SpeakStatus } from './actions.js'
import { BrokerEcho } from './broker-echo.js'
import type { BrokerSeed } from './broker-seed.js'
import {
  ALEXA_SPEAK_ADDON_ID,
  ALEXA_SPEAK_KIND,
  DEVICE_REFRESH_MS,
  type SpeakMode,
} from './constants.js'
import {
  legacyLoginOf,
  noticeFor,
  planLegacyMigration,
  unassignedCount,
  type SpeakTargetRow,
} from './migration.js'
import {
  createAlexaNotificationProvider,
  type AlexaNotificationProvider,
  type SpeakBrokerView,
} from './provider.js'
import { resolveAlexaWorkerScript } from './python-paths.js'
import type { SpeakSessionStore } from './session-store.js'
import { startAlexaWorker, type AlexaWorker } from './worker-client.js'
import type { TargetDelivery } from './worker-protocol.js'

/** An Amazon account the addon imports from, as far as speech needs to know. */
export interface SpeakBrokerRef {
  readonly id: string
  readonly name: string
  readonly amazonDomain: string
}

export interface AlexaSpeakHost {
  readonly logger: IScopedLogger
  readonly readConfig: () => { speak?: unknown }
  readonly writeSpeak: (speak: AlexaSpeakSettings) => Promise<void>
  /** The brokers right now. Read on every use: accounts come and go. */
  readonly listBrokers: () => readonly SpeakBrokerRef[]
  /** The broker's current refresh token, or null when it holds none. */
  readonly readSeed: (brokerId: string) => Promise<BrokerSeed | null>
  readonly sessions: SpeakSessionStore
  /** Forget the keychain copies of the old standalone login. */
  readonly clearLegacySecrets: () => Promise<void>
  readonly ensurePython: () => Promise<string | null>
  /** Tests inject a fake worker; production starts the Python one. */
  readonly startWorker?: (brokerId: string, pythonPath: string) => AlexaWorker
  readonly now?: () => number
}

export type AlexaSpeakHandlers = {
  [K in keyof typeof alexaSpeakActions]: (
    input: z.infer<(typeof alexaSpeakActions)[K]['input']>,
  ) => Promise<z.infer<(typeof alexaSpeakActions)[K]['output']>>
}

function targetsFrom(settings: AlexaSpeakSettings): readonly Target[] {
  return settings.targets.map((row) => ({
    id: row.id,
    name: row.name,
    kind: ALEXA_SPEAK_KIND,
    addonId: ALEXA_SPEAK_ADDON_ID,
    enabled: row.enabled,
    config: {
      ...(row.brokerId.length > 0 ? { brokerId: row.brokerId } : {}),
      echoId: row.echoId,
      mode: row.mode,
      volume: row.volume,
      respectDnd: row.respectDnd,
    },
  }))
}

function rowsFrom(targets: readonly Target[]): readonly SpeakTargetRow[] {
  return targets.map((target) => ({
    id: target.id,
    name: target.name,
    enabled: target.enabled,
    brokerId: typeof target.config['brokerId'] === 'string' ? target.config['brokerId'] : '',
    echoId: typeof target.config['echoId'] === 'string' ? target.config['echoId'] : '',
    mode: target.config['mode'] === 'announce' ? 'announce' : 'speak',
    volume: typeof target.config['volume'] === 'number' ? target.config['volume'] : 40,
    respectDnd: target.config['respectDnd'] !== false,
  }))
}

export class AlexaSpeakController {
  readonly provider: AlexaNotificationProvider
  private settings: AlexaSpeakSettings
  private pythonPath: string | null = null
  private readonly echoes = new Map<string, BrokerEcho>()
  private timer: ReturnType<typeof setInterval> | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly host: AlexaSpeakHost) {
    this.now = host.now ?? (() => Date.now())
    this.settings = readSpeakSettings(host.readConfig())
    this.provider = createAlexaNotificationProvider({
      brokers: () => this.brokerViews(),
      now: this.now,
      logger: host.logger,
      loadTargets: () => targetsFrom(this.settings),
      saveTargets: (targets) => {
        this.settings = { ...this.settings, targets: [...rowsFrom(targets)] }
        void this.persist()
      },
      speak: (command) =>
        this.utter(command.brokerId, command.mode, command.targets, command.text, command.volume),
    })
  }

  async start(): Promise<void> {
    this.pythonPath = await this.host.ensurePython()
    if (this.pythonPath === null) {
      this.host.logger.warn('alexa speak: embedded Python unavailable; Echo speech will not run')
      return
    }
    await this.migrateLegacyLogin()
    await this.brokersChanged()
    this.timer = setInterval(() => {
      void this.refreshAll()
    }, DEVICE_REFRESH_MS)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    for (const echo of this.echoes.values()) echo.stop()
    this.echoes.clear()
  }

  /** The addon calls this whenever its list of brokers may have changed. */
  brokersChanged(): Promise<void> {
    this.queue = this.queue.then(() => this.reconcile()).catch(() => undefined)
    return this.queue
  }

  handlers(): AlexaSpeakHandlers {
    return {
      speakStatus: async () => this.status(),
      sendTest: async (input) => this.sendTest(input),
    }
  }

  private brokerViews(): readonly SpeakBrokerView[] {
    return this.host.listBrokers().map((ref) => {
      const echo = this.echoes.get(ref.id)
      return {
        id: ref.id,
        name: ref.name,
        ready: echo?.state === 'ready',
        devices: echo?.devices ?? [],
      }
    })
  }

  private async persist(): Promise<void> {
    try {
      await this.host.writeSpeak(this.settings)
    } catch (err: unknown) {
      this.host.logger.warn('alexa speak: could not store settings', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Drain the old standalone login once. With exactly one broker its jar and
   * its targets move onto that broker; otherwise the jar is dropped and the
   * targets wait for the operator to choose (the status names that state).
   */
  private async migrateLegacyLogin(): Promise<void> {
    const brokers = this.host.listBrokers()
    const plan = planLegacyMigration(
      legacyLoginOf(this.settings),
      brokers.map((ref) => ref.id),
      this.settings.targets,
    )
    if (!plan.present) return
    if (plan.attachTo !== null) {
      await this.host.sessions.put(plan.attachTo, this.settings.session)
    }
    this.settings = {
      ...this.settings,
      email: '',
      password: '',
      session: '',
      targets: [...plan.targets],
    }
    await this.persist()
    await this.host.clearLegacySecrets()
    this.host.logger.info('alexa speak: the old standalone login was retired', {
      meta: {
        attachedTo: plan.attachTo ?? 'none',
        brokers: brokers.length,
        targets: plan.targets.length,
      },
    })
  }

  private makeWorker(brokerId: string, pythonPath: string): AlexaWorker {
    if (this.host.startWorker !== undefined) return this.host.startWorker(brokerId, pythonPath)
    return startAlexaWorker({
      pythonPath,
      scriptPath: resolveAlexaWorkerScript(),
      logger: this.host.logger.withTags({ brokerId }),
      now: this.now,
    })
  }

  private async reconcile(): Promise<void> {
    const pythonPath = this.pythonPath
    if (pythonPath === null) return
    const refs = this.host.listBrokers()
    const live = new Set(refs.map((ref) => ref.id))
    for (const [id, echo] of this.echoes) {
      if (live.has(id)) continue
      echo.stop()
      this.echoes.delete(id)
      await this.host.sessions.delete(id).catch((err: unknown) => {
        this.host.logger.warn('alexa speak: could not drop the session of a removed account', {
          tags: { brokerId: id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    const fresh = refs.filter((ref) => !this.echoes.has(ref.id))
    for (const ref of fresh) {
      this.echoes.set(
        ref.id,
        new BrokerEcho({
          brokerId: ref.id,
          brokerName: ref.name,
          domain: ref.amazonDomain,
          worker: this.makeWorker(ref.id, pythonPath),
          readSeed: () => this.host.readSeed(ref.id),
          sessions: this.host.sessions,
          logger: this.host.logger,
        }),
      )
    }
    // A session that is not ready retries now: the broker may just have signed in.
    await Promise.all(
      refs.map(async (ref) => {
        const echo = this.echoes.get(ref.id)
        if (echo !== undefined && (fresh.includes(ref) || echo.state !== 'ready')) {
          await echo.signIn()
        }
      }),
    )
  }

  private async refreshAll(): Promise<void> {
    for (const echo of this.echoes.values()) {
      if (echo.state === 'ready') await echo.refreshDevices()
      else await echo.signIn()
    }
  }

  private async utter(
    brokerId: string,
    mode: SpeakMode,
    targets: readonly string[],
    text: string,
    volume: number,
  ): Promise<readonly TargetDelivery[]> {
    const echo = this.echoes.get(brokerId)
    if (echo === undefined) throw new Error('no Echo session for this Amazon account')
    return echo.utter(mode === 'announce' ? 'announce' : 'speak', targets, text, volume)
  }

  private async status(): Promise<SpeakStatus> {
    const brokers = this.host.listBrokers()
    const rows = await Promise.all(
      brokers.map(async (ref) => {
        const echo = this.echoes.get(ref.id)
        return {
          id: ref.id,
          name: ref.name,
          state: echo?.state ?? 'failed',
          ...(echo === undefined
            ? { error: 'embedded Python unavailable' }
            : echo.error === null
              ? {}
              : { error: echo.error }),
          devices: [...(echo?.devices ?? [])],
          session:
            echo === undefined
              ? { loggedIn: false, ageSec: 0, lastSuccessAt: null }
              : await echo.session(),
        }
      }),
    )
    const targets = this.settings.targets
    const ids = brokers.map((ref) => ref.id)
    return {
      brokers: rows,
      unassignedTargets: unassignedCount(targets),
      notice: noticeFor(targets, ids),
    }
  }

  private async sendTest(input: {
    brokerId: string
    echoIds: readonly string[]
    mode: SpeakMode
    volume: number
    text: string
  }): Promise<{ outcomes: Array<{ echoId: string; ok: boolean; error?: string }> }> {
    const outcomes = await this.utter(
      input.brokerId,
      input.mode,
      input.echoIds,
      input.text,
      input.volume,
    )
    const known = new Map(
      (this.echoes.get(input.brokerId)?.devices ?? []).map((device) => [device.id, device]),
    )
    const next = [...this.settings.targets]
    for (const echoId of input.echoIds) {
      if (next.some((row) => row.echoId === echoId && row.brokerId === input.brokerId)) continue
      next.push({
        id: `echo-${input.brokerId}-${echoId}`,
        name: known.get(echoId)?.name ?? echoId,
        enabled: true,
        brokerId: input.brokerId,
        echoId,
        mode: input.mode,
        volume: input.volume,
        respectDnd: true,
      })
    }
    this.settings = { ...this.settings, targets: next }
    await this.persist()
    return {
      outcomes: outcomes.map((row) => ({
        echoId: row.targetId,
        ok: row.ok,
        ...(row.error !== undefined ? { error: row.error } : {}),
      })),
    }
  }
}
