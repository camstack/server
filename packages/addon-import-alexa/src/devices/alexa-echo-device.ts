import { z } from 'zod'
import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  doNotDisturbCapability,
  mediaPlayerCapability,
  type DeviceContext,
  type DoNotDisturbStatus,
  type InferNativeProvider,
  type MediaPlayerStatus,
} from '@camstack/types'
import { alexaEchoSessions, type EchoSession } from '../alexa-echo-sessions.js'
import { emptyEchoStatus, mapPlayerInfoToStatus } from '../alexa-echo-state-to-cap.js'
import { ECHO_POLL_MS, ECHO_REREAD_MS } from '../speak/constants.js'
import { RateLimitedError, type NpCommand } from '../speak/worker-protocol.js'

/**
 * An Echo is a media-player device. Identity only: the account (`brokerId`) and
 * the Echo's serial. The Echo's notification target is a separate record linked
 * by the same (brokerId, serial); nothing here sets or reads a notification.
 */
export const alexaEchoDeviceSchema = z.object({
  brokerId: z.string().min(1).describe('Registry broker id'),
  serial: z.string().min(1).describe('The Echo serial number'),
  deviceType: z.string().default('').describe('Amazon device type id'),
  system: z.literal('alexa').optional(),
  integrationId: z.string().optional(),
})

export type AlexaEchoDeviceConfig = z.infer<typeof alexaEchoDeviceSchema>

/** `ok` after a good read, `rate-limited` while Amazon asked for a pause, `degraded` after a failed read. */
export type EchoPollHealth = 'ok' | 'rate-limited' | 'degraded'

const COLD_DND: DoNotDisturbStatus = { enabled: null, lastChangedAt: 0 }

function unsupported(what: string): never {
  throw new Error(`${what} is not available on an Echo`)
}

export class AlexaEchoDevice extends BaseDevice<typeof alexaEchoDeviceSchema> {
  readonly features: readonly DeviceFeature[] = [
    DeviceFeature.MediaPlayerVolume,
    DeviceFeature.MediaPlayerNext,
    DeviceFeature.MediaPlayerPrevious,
  ]

  private readonly brokerId: string
  private readonly serial: string
  private readonly amazonDeviceType: string
  private timer: ReturnType<typeof setInterval> | null = null
  private rereadTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private failureLogged = false
  private health: EchoPollHealth = 'ok'

  constructor(ctx: DeviceContext) {
    const persisted = alexaEchoDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, alexaEchoDeviceSchema, { type: DeviceType.MediaPlayer })
    this.brokerId = persisted.brokerId
    this.serial = persisted.serial
    this.amazonDeviceType = persisted.deviceType
  }

  /** The outcome of the last read, for the broker status and the specs. */
  get pollHealth(): EchoPollHealth {
    return this.health
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerMediaPlayer()
    this.registerDoNotDisturb()
    this.runtimeState.setCapState('media-player', emptyEchoStatus('off', 0))
    this.runtimeState.setCapState('do-not-disturb', COLD_DND)
    void this.poll()
    this.timer = setInterval(() => void this.poll(), ECHO_POLL_MS)
    this.timer.unref()
  }

  override async removeDevice(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.rereadTimer !== null) clearTimeout(this.rereadTimer)
    this.timer = null
    this.rereadTimer = null
    await super.removeDevice()
  }

  private session(): EchoSession {
    const session = alexaEchoSessions.get(this.brokerId)
    if (session === null) throw new Error('the Amazon account of this Echo is not connected')
    return session
  }

  /** One re-read shortly after a command, once Amazon has applied it. */
  private rereadSoon(): void {
    if (this.rereadTimer !== null) clearTimeout(this.rereadTimer)
    this.rereadTimer = setTimeout(() => {
      this.rereadTimer = null
      void this.poll()
    }, ECHO_REREAD_MS)
    this.rereadTimer.unref()
  }

  /**
   * Read the player and Do Not Disturb. A failed read leaves both slices as they
   * were and marks the device degraded; a 429 is a pause, not a fault. Never throws.
   */
  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.readOnce()
    } finally {
      this.polling = false
    }
  }

  private async readOnce(): Promise<void> {
    const session = alexaEchoSessions.get(this.brokerId)
    if (session === null || session.state !== 'ready') return
    if (session.rateLimitedUntil !== null) {
      this.health = 'rate-limited'
      return
    }
    const listed = session.devices.find((device) => device.id === this.serial)
    if (listed !== undefined && !listed.online) {
      this.runtimeState.setCapState('media-player', emptyEchoStatus('off', Date.now()))
      this.markOnline(false)
      this.health = 'ok'
      return
    }
    const deviceType =
      this.amazonDeviceType !== '' ? this.amazonDeviceType : (listed?.deviceType ?? '')
    try {
      const info = await session.playerState(this.serial, deviceType)
      const now = Date.now()
      this.runtimeState.setCapState(
        'media-player',
        mapPlayerInfoToStatus(info, { online: true, now }),
      )
      this.markOnline(true)
      this.noteRecovered()
    } catch (err: unknown) {
      this.noteReadFailure(err)
      return
    }
    await this.readDoNotDisturb()
  }

  private async readDoNotDisturb(): Promise<void> {
    try {
      const all = await alexaEchoSessions.dnd(this.brokerId, Date.now())
      const enabled = all.get(this.serial)
      if (enabled === undefined) return
      this.runtimeState.setCapState('do-not-disturb', {
        enabled,
        lastChangedAt: Date.now(),
      })
    } catch (err: unknown) {
      this.noteReadFailure(err)
    }
  }

  private noteRecovered(): void {
    if (this.failureLogged) {
      this.ctx.logger.info('alexa echo: reads are working again', {
        tags: { deviceId: this.id },
      })
    }
    this.failureLogged = false
    this.health = 'ok'
  }

  private noteReadFailure(err: unknown): void {
    if (err instanceof RateLimitedError) {
      this.health = 'rate-limited'
      this.ctx.logger.info('alexa echo: amazon asked for a pause, keeping the last state', {
        tags: { deviceId: this.id },
      })
      return
    }
    this.health = 'degraded'
    if (this.failureLogged) return
    this.failureLogged = true
    this.ctx.logger.warn('alexa echo: could not read the player, keeping the last state', {
      tags: { deviceId: this.id },
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  }

  private async command(command: NpCommand): Promise<void> {
    await this.session().npCommand(this.serial, command)
    this.rereadSoon()
  }

  private registerMediaPlayer(): void {
    const provider: InferNativeProvider<typeof mediaPlayerCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<MediaPlayerStatus>('media-player') ??
        emptyEchoStatus('off', 0),
      play: () => this.command('play'),
      pause: () => this.command('pause'),
      next: () => this.command('next'),
      previous: () => this.command('previous'),
      setVolume: async ({ volumeLevel }) => {
        await this.session().setVolume(this.serial, Math.round(volumeLevel))
        this.rereadSoon()
      },
      stop: async () => unsupported('stop'),
      turnOn: async () => unsupported('power'),
      turnOff: async () => unsupported('power'),
      volumeUp: async () => unsupported('volume steps'),
      volumeDown: async () => unsupported('volume steps'),
      channelUp: async () => unsupported('channel steps'),
      channelDown: async () => unsupported('channel steps'),
      seek: async () => unsupported('seek'),
      setMute: async () => unsupported('mute'),
      setShuffle: async () => unsupported('shuffle'),
      setRepeat: async () => unsupported('repeat'),
      selectSource: async () => unsupported('source selection'),
      playMedia: async () => unsupported('playing media'),
    }
    this.ctx.registerNativeCap(mediaPlayerCapability, provider)
  }

  private registerDoNotDisturb(): void {
    const provider: InferNativeProvider<typeof doNotDisturbCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<DoNotDisturbStatus>('do-not-disturb') ?? COLD_DND,
      setEnabled: async ({ enabled }) => {
        await this.session().setDnd(this.serial, enabled)
        this.runtimeState.setCapState('do-not-disturb', {
          enabled,
          lastChangedAt: Date.now(),
        })
      },
    }
    this.ctx.registerNativeCap(doNotDisturbCapability, provider)
  }
}
