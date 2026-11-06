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
import {
  emptyEchoStatus,
  mapPlayerInfoToStatus,
  withListedVolume,
} from '../alexa-echo-state-to-cap.js'
import {
  ECHO_POLL_MS,
  ECHO_POLL_PUSH_HEALTHY_MS,
  ECHO_PUSH_READ_GAP_MS,
  ECHO_REREAD_MS,
} from '../speak/constants.js'
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

/** Percent points one volume-up / volume-down moves an Echo. */
const VOLUME_STEP = 10

const COLD_DND: DoNotDisturbStatus = { enabled: null, lastChangedAt: 0 }

function unsupported(what: string): never {
  throw new Error(`${what} is not available on an Echo`)
}

export class AlexaEchoDevice extends BaseDevice<typeof alexaEchoDeviceSchema> {
  readonly features: readonly DeviceFeature[] = [
    DeviceFeature.MediaPlayerVolume,
    DeviceFeature.MediaPlayerNext,
    DeviceFeature.MediaPlayerPrevious,
    DeviceFeature.MediaPlayerShuffle,
    DeviceFeature.MediaPlayerRepeat,
  ]

  private readonly brokerId: string
  private readonly serial: string
  private readonly amazonDeviceType: string
  private timer: ReturnType<typeof setInterval> | null = null
  private rereadTimer: ReturnType<typeof setTimeout> | null = null
  private pushReadTimer: ReturnType<typeof setTimeout> | null = null
  private lastPushReadAt = 0
  private repollAfter = false
  private unsubscribers: Array<() => void> = []
  private polling = false
  private failureLogged = false
  private volumeFailureLogged = false
  private health: EchoPollHealth = 'ok'
  /** When this device last wrote its volume / Do Not Disturb optimistically; a read that began earlier must not overwrite it. */
  private volumeSetAt = 0
  private dndSetAt = 0
  /** Counts this device's sets; a refused set reverts only while it is still the latest. */
  private volumeSeq = 0
  private dndSeq = 0
  /** The level Amazon last took (a good set, or a read newer than every set); undefined until one is known. */
  private volumeSettled: number | null | undefined = undefined
  private dndSettled: boolean | null | undefined = undefined

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
    this.armPollTimer()
    this.unsubscribers = [
      alexaEchoSessions.onEcho(this.brokerId, this.serial, () => this.onPushEvent()),
      alexaEchoSessions.onChannel(this.brokerId, (state) => this.onChannel(state)),
    ]
  }

  /** The poll pace now: slow while the push channel is up, normal when it is down. */
  get pollIntervalMs(): number {
    return alexaEchoSessions.pushChannel(this.brokerId) === 'up'
      ? ECHO_POLL_PUSH_HEALTHY_MS
      : ECHO_POLL_MS
  }

  private armPollTimer(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs)
    this.timer.unref()
  }

  private onChannel(state: 'up' | 'down'): void {
    this.armPollTimer()
    this.ctx.logger.info('alexa echo: push channel changed, poll pace follows', {
      tags: { deviceId: this.id },
      meta: { channel: state, pollMs: this.pollIntervalMs },
    })
    // Events sent while the channel was down are lost: read once on every change.
    void this.poll()
  }

  /**
   * Amazon pushed a change for this Echo: read it once, no sooner than the gap after the
   * last push read. The read is the ordinary one, so the optimistic-set guard applies as
   * it does to a poll: a read that began before a set never undoes it.
   */
  private onPushEvent(): void {
    if (this.pushReadTimer !== null) return
    const wait = Math.max(0, this.lastPushReadAt + ECHO_PUSH_READ_GAP_MS - Date.now())
    this.pushReadTimer = setTimeout(() => {
      this.pushReadTimer = null
      this.lastPushReadAt = Date.now()
      // A read already in flight may have begun before this change: read again after it.
      if (this.polling) this.repollAfter = true
      else void this.poll()
    }, wait)
    this.pushReadTimer.unref()
  }

  override async removeDevice(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.rereadTimer !== null) clearTimeout(this.rereadTimer)
    if (this.pushReadTimer !== null) clearTimeout(this.pushReadTimer)
    for (const off of this.unsubscribers) off()
    this.unsubscribers = []
    this.timer = null
    this.rereadTimer = null
    this.pushReadTimer = null
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
    if (this.repollAfter) {
      this.repollAfter = false
      await this.poll()
    }
  }

  private async readOnce(): Promise<void> {
    const readStartedAt = Date.now()
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
      const info = await session.playerState(this.serial, deviceType, this.id)
      const now = Date.now()
      const fromPlayer = mapPlayerInfoToStatus(info, { online: true, now })
      const read = await this.completeVolume(fromPlayer)
      const kept = this.keepNewerVolume(read, readStartedAt)
      if (kept === read) this.volumeSettled = read.volumeLevel
      this.runtimeState.setCapState('media-player', kept)
      this.markOnline(true)
      this.noteRecovered()
    } catch (err: unknown) {
      this.noteReadFailure(err)
      return
    }
    await this.readDoNotDisturb(readStartedAt)
  }

  /**
   * An idle Echo's player read carries no volume. Ask the account's volume list
   * (shared by every Echo of the account in this cycle); a failed read leaves null.
   */
  private async completeVolume(status: MediaPlayerStatus): Promise<MediaPlayerStatus> {
    if (status.volumeLevel !== null && status.isMuted !== null) return status
    try {
      const all = await alexaEchoSessions.volumes(this.brokerId, Date.now())
      if (this.volumeFailureLogged) {
        this.ctx.logger.info('alexa echo: the volume list reads again', {
          tags: { deviceId: this.id },
        })
      }
      this.volumeFailureLogged = false
      return withListedVolume(status, all.get(this.serial))
    } catch (err: unknown) {
      if (err instanceof RateLimitedError) return status
      if (!this.volumeFailureLogged) {
        this.volumeFailureLogged = true
        this.ctx.logger.warn('alexa echo: could not read the volume list, volume stays unknown', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
      return status
    }
  }

  /**
   * A read that began before this device last set its volume carries the level from
   * before the set: keep the level the operator chose (and its mute), take the rest.
   */
  private keepNewerVolume(read: MediaPlayerStatus, readStartedAt: number): MediaPlayerStatus {
    if (this.volumeSetAt < readStartedAt) return read
    const current = this.runtimeState.getCapState<MediaPlayerStatus>('media-player')
    if (current === undefined) return read
    return { ...read, volumeLevel: current.volumeLevel, isMuted: current.isMuted }
  }

  private async readDoNotDisturb(readStartedAt: number): Promise<void> {
    try {
      const all = await alexaEchoSessions.dnd(this.brokerId, Date.now())
      const enabled = all.get(this.serial)
      if (enabled === undefined) return
      if (this.dndSetAt >= readStartedAt) return
      this.dndSettled = enabled
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
    await this.session().npCommand(this.serial, command, this.id)
    this.rereadSoon()
  }

  /**
   * The slice shows the new level at once; Amazon is told next. On a refusal the
   * slice goes back to the level Amazon last took (a good set, else the last read,
   * else what the slice held), with a new stamp, and the error is rethrown
   * (RateLimitedError included) after a warning. Only the LATEST set reverts: when
   * a newer set has superseded this one, that set owns the slice, so an earlier
   * refusal never writes over it, and a later refusal falls back to what Amazon
   * actually took, never to a level it did not. A cold slice (no read yet) gets no
   * optimistic write, so no state is invented.
   */
  private async sendVolume(level: number): Promise<void> {
    const previous = this.runtimeState.getCapState<MediaPlayerStatus>('media-player')
    const setAt = Date.now()
    const seq = ++this.volumeSeq
    this.volumeSetAt = setAt
    if (previous !== undefined) {
      this.runtimeState.setCapState('media-player', {
        ...previous,
        volumeLevel: level,
        lastChangedAt: setAt,
      })
    }
    alexaEchoSessions.invalidateVolumes(this.brokerId)
    try {
      await this.session().setVolume(this.serial, level, this.id)
      this.volumeSettled = level
    } catch (err: unknown) {
      const back =
        this.volumeSettled !== undefined ? this.volumeSettled : (previous?.volumeLevel ?? null)
      const current = this.runtimeState.getCapState<MediaPlayerStatus>('media-player')
      if (seq === this.volumeSeq && current !== undefined) {
        this.runtimeState.setCapState('media-player', {
          ...current,
          volumeLevel: back,
          lastChangedAt: Date.now(),
        })
      }
      this.ctx.logger.warn('alexa echo: Amazon refused the volume, back to the previous level', {
        tags: { deviceId: this.id },
        meta: {
          from: back,
          to: level,
          superseded: seq !== this.volumeSeq,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      throw err
    }
  }

  /**
   * Amazon has no step command: move from the level in the slice (it already holds
   * the last level we set); refuse when there is none.
   */
  private async stepVolume(delta: number): Promise<void> {
    const level = this.runtimeState.getCapState<MediaPlayerStatus>('media-player')?.volumeLevel
    if (level === null || level === undefined) throw new Error('the Echo volume is not known yet')
    await this.sendVolume(Math.max(0, Math.min(100, level + delta)))
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
      setVolume: async ({ volumeLevel }) => this.sendVolume(Math.round(volumeLevel)),
      stop: async () => unsupported('stop'),
      turnOn: async () => unsupported('power'),
      turnOff: async () => unsupported('power'),
      volumeUp: async () => this.stepVolume(VOLUME_STEP),
      volumeDown: async () => this.stepVolume(-VOLUME_STEP),
      channelUp: async () => unsupported('channel steps'),
      channelDown: async () => unsupported('channel steps'),
      seek: async () => unsupported('seek'),
      setMute: async () => unsupported('mute'),
      setShuffle: ({ shuffle }) => this.command(shuffle ? 'shuffle-on' : 'shuffle-off'),
      setRepeat: async ({ repeat }) => {
        // Amazon's repeat is a boolean: it repeats the queue, never one track.
        if (repeat === 'one') unsupported('repeat one')
        await this.command(repeat === 'all' ? 'repeat-on' : 'repeat-off')
      },
      selectSource: async () => unsupported('source selection'),
      playMedia: async () => unsupported('playing media'),
    }
    this.ctx.registerNativeCap(mediaPlayerCapability, provider)
  }

  /** Optimistic like the volume, with the same rules: only the latest refused set reverts, to what Amazon last took. */
  private async sendDnd(enabled: boolean): Promise<void> {
    const previous =
      this.runtimeState.getCapState<DoNotDisturbStatus>('do-not-disturb') ?? COLD_DND
    const setAt = Date.now()
    const seq = ++this.dndSeq
    this.dndSetAt = setAt
    this.runtimeState.setCapState('do-not-disturb', { enabled, lastChangedAt: setAt })
    alexaEchoSessions.invalidateDnd(this.brokerId)
    try {
      await this.session().setDnd(this.serial, enabled, this.id)
      this.dndSettled = enabled
    } catch (err: unknown) {
      const back = this.dndSettled !== undefined ? this.dndSettled : previous.enabled
      if (seq === this.dndSeq) {
        this.runtimeState.setCapState('do-not-disturb', {
          enabled: back,
          lastChangedAt: Date.now(),
        })
      }
      this.ctx.logger.warn('alexa echo: Amazon refused Do Not Disturb, back to the previous state', {
        tags: { deviceId: this.id },
        meta: {
          from: back,
          to: enabled,
          superseded: seq !== this.dndSeq,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      throw err
    }
  }

  private registerDoNotDisturb(): void {
    const provider: InferNativeProvider<typeof doNotDisturbCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<DoNotDisturbStatus>('do-not-disturb') ?? COLD_DND,
      setEnabled: async ({ enabled }) => this.sendDnd(enabled),
    }
    this.ctx.registerNativeCap(doNotDisturbCapability, provider)
  }
}
