/**
 * Owns the one Python worker, the keychain session, the Echo cache and the
 * notification provider. A login that needs a code raises one alert.
 */
import { isSecretMarker, type Alert, type IScopedLogger, type Target } from '@camstack/types'
import type { z } from 'zod'
import type { AlexaSpeakSettings } from '../config.js'
import { readSpeakSettings } from '../config.js'
import { alexaSpeakActions } from './actions.js'
import {
  ALEXA_SPEAK_ADDON_ID,
  ALEXA_SPEAK_KIND,
  DEVICE_REFRESH_MS,
  type AlexaRegion,
  type SpeakMode,
} from './constants.js'
import type { SetupPhase } from './setup-flow.js'
import { OtpAttention } from './otp-alert.js'
import { createAlexaNotificationProvider, type AlexaNotificationProvider } from './provider.js'
import { resolveAlexaWorkerScript } from './python-paths.js'
import { type SpeakSecretPaths, withSpeakSecretFiles } from './secret-file.js'
import { reduceSetup } from './setup-flow.js'
import { startAlexaWorker, type AlexaWorker } from './worker-client.js'
import {
  type EchoDevice,
  type LoginStartResult,
  type SessionStatus,
  type TargetDelivery,
  parseDeliveries,
  parseDevices,
  parseLoginResult,
  parseSessionStatus,
} from './worker-protocol.js'

export interface AlexaSpeakHost {
  readonly logger: IScopedLogger
  readonly readConfig: () => { speak?: unknown }
  readonly writeSpeak: (speak: AlexaSpeakSettings) => Promise<void>
  readonly emitAlert: (alert: Alert) => Promise<void>
  readonly resolveAlert: (alertId: string) => Promise<void>
  readonly ensurePython: () => Promise<string | null>
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
      echoId: row.echoId,
      mode: row.mode,
      volume: row.volume,
      respectDnd: row.respectDnd,
    },
  }))
}

function withTargets(settings: AlexaSpeakSettings, targets: readonly Target[]): AlexaSpeakSettings {
  return {
    ...settings,
    targets: targets.map((target) => ({
      id: target.id,
      name: target.name,
      enabled: target.enabled,
      echoId: typeof target.config['echoId'] === 'string' ? target.config['echoId'] : '',
      mode: target.config['mode'] === 'announce' ? 'announce' : 'speak',
      volume: typeof target.config['volume'] === 'number' ? target.config['volume'] : 40,
      respectDnd: target.config['respectDnd'] !== false,
    })),
  }
}

function usablePassword(value: string): string {
  if (value.length === 0 || isSecretMarker(value)) return ''
  return value
}

export class AlexaSpeakController {
  readonly provider: AlexaNotificationProvider
  private settings: AlexaSpeakSettings
  private worker: AlexaWorker | null = null
  private devices: readonly EchoDevice[] = []
  private phase: SetupPhase = 'sign-in'
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly attention: OtpAttention
  private readonly now: () => number

  constructor(private readonly host: AlexaSpeakHost) {
    this.now = host.now ?? (() => Date.now())
    this.settings = readSpeakSettings(host.readConfig())
    this.phase = this.settings.session.length > 0 ? 'devices' : 'sign-in'
    this.attention = new OtpAttention({
      now: this.now,
      emit: (alert) => host.emitAlert(alert),
      resolve: (id) => host.resolveAlert(id),
    })
    this.provider = createAlexaNotificationProvider({
      devices: () => this.devices,
      loggedIn: () => this.phase === 'devices',
      now: this.now,
      logger: host.logger,
      loadTargets: () => targetsFrom(this.settings),
      saveTargets: (targets) => {
        this.settings = withTargets(this.settings, targets)
        void this.persist()
      },
      speak: (command) => this.utter(command.mode, command.targets, command.text, command.volume),
    })
  }

  async start(): Promise<void> {
    const pythonPath = await this.host.ensurePython()
    if (pythonPath === null) {
      this.host.logger.warn('alexa speak: embedded Python unavailable; Echo speech will not run')
      return
    }
    this.worker = startAlexaWorker({
      pythonPath,
      scriptPath: resolveAlexaWorkerScript(),
      logger: this.host.logger,
      now: this.now,
    })
    this.noteSecrets()
    if (this.settings.session.length > 0) {
      await this.loginWithFiles().catch((err: unknown) => {
        this.host.logger.warn('alexa speak: stored session did not restore', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    this.timer = setInterval(() => {
      void this.refreshDevices()
    }, DEVICE_REFRESH_MS)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.worker?.stop()
    this.worker = null
  }

  handlers(): AlexaSpeakHandlers {
    return {
      speakStatus: async () => this.status(),
      loginStart: async (input) => {
        this.settings = {
          ...this.settings,
          email: input.email,
          password: input.password,
          region: input.region,
        }
        await this.persist()
        this.noteSecrets()
        return this.loginWithFiles()
      },
      loginOtp: async (input) => this.otpWithFiles(input.code),
      sendTest: async (input) => this.sendTest(input),
    }
  }

  private noteSecrets(): void {
    const password = usablePassword(this.settings.password)
    this.worker?.noteSecrets(password.length > 0 ? [password] : [])
  }

  private async persist(): Promise<void> {
    try {
      await this.host.writeSpeak(this.settings)
    } catch (err) {
      this.host.logger.warn('alexa speak: could not store settings', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private workerRequest(request: Parameters<AlexaWorker['request']>[0]): Promise<unknown> {
    const worker = this.worker
    if (worker === null || worker.failed)
      return Promise.reject(new Error('alexa worker is not running'))
    return worker.request(request)
  }

  private async loginWithFiles(): Promise<LoginStartResult> {
    let outcome: LoginStartResult = { status: 'failed', error: 'alexa worker is not running' }
    const held = await withSpeakSecretFiles(
      { password: usablePassword(this.settings.password), sessionB64: this.settings.session },
      async (paths) => {
        outcome = await this.applyLogin(await this.loginRequest(paths))
      },
    )
    if (held.sessionB64 !== this.settings.session) {
      this.settings = { ...this.settings, session: held.sessionB64 }
      await this.persist()
    }
    return outcome
  }

  private async otpWithFiles(code: string): Promise<LoginStartResult> {
    let outcome: LoginStartResult = { status: 'failed', error: 'alexa worker is not running' }
    const held = await withSpeakSecretFiles(
      { password: '', sessionB64: this.settings.session },
      async (paths) => {
        outcome = await this.applyLogin(
          await this.workerRequest({ op: 'login_otp', code, sessionPath: paths.sessionPath }),
        )
      },
    )
    if (held.sessionB64 !== this.settings.session) {
      this.settings = { ...this.settings, session: held.sessionB64 }
      await this.persist()
    }
    return outcome
  }

  private loginRequest(paths: SpeakSecretPaths): Promise<unknown> {
    return this.workerRequest({
      op: 'login_start',
      email: this.settings.email,
      passwordPath: paths.passwordPath,
      sessionPath: paths.sessionPath,
      region: this.settings.region,
    })
  }

  private async applyLogin(raw: unknown): Promise<LoginStartResult> {
    const outcome = parseLoginResult(raw)
    this.phase = reduceSetup(this.phase, { type: 'login', status: outcome.status })
    if (outcome.status === 'otp_needed') await this.attention.needed('otp')
    else if (outcome.status === 'captcha') await this.attention.needed('captcha')
    else if (outcome.status === 'ok') {
      await this.attention.cleared()
      await this.refreshDevices()
    }
    return outcome
  }

  private async refreshDevices(): Promise<void> {
    if (this.worker === null || this.phase !== 'devices') return
    try {
      this.devices = [...parseDevices(await this.workerRequest({ op: 'devices' }))]
    } catch (err) {
      this.host.logger.warn('alexa speak: device refresh failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private async utter(
    mode: SpeakMode,
    targets: readonly string[],
    text: string,
    volume: number,
  ): Promise<readonly TargetDelivery[]> {
    const op = mode === 'announce' ? 'announce' : 'speak'
    return parseDeliveries(await this.workerRequest({ op, targets, text, volume }))
  }

  private async session(): Promise<SessionStatus> {
    if (this.worker === null) return { loggedIn: false, ageSec: 0, lastSuccessAt: null }
    try {
      return parseSessionStatus(await this.workerRequest({ op: 'session_status' }))
    } catch {
      return { loggedIn: this.phase === 'devices', ageSec: 0, lastSuccessAt: null }
    }
  }

  private async status(): Promise<{
    phase: SetupPhase
    email: string
    region: AlexaRegion
    devices: EchoDevice[]
    session: SessionStatus
  }> {
    return {
      phase: this.phase,
      email: this.settings.email,
      region: this.settings.region,
      devices: [...this.devices],
      session: await this.session(),
    }
  }

  private async sendTest(input: {
    echoIds: readonly string[]
    mode: SpeakMode
    volume: number
    text: string
  }): Promise<{ outcomes: Array<{ echoId: string; ok: boolean; error?: string }> }> {
    const outcomes = await this.utter(input.mode, input.echoIds, input.text, input.volume)
    const known = new Map(this.devices.map((device) => [device.id, device]))
    const next = [...targetsFrom(this.settings)]
    for (const echoId of input.echoIds) {
      if (next.some((row) => row.config['echoId'] === echoId)) continue
      const device = known.get(echoId)
      next.push({
        id: `echo-${echoId}`,
        name: device?.name ?? echoId,
        kind: ALEXA_SPEAK_KIND,
        addonId: ALEXA_SPEAK_ADDON_ID,
        enabled: true,
        config: { echoId, mode: input.mode, volume: input.volume, respectDnd: true },
      })
    }
    this.settings = withTargets(this.settings, next)
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
