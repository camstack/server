/**
 * Doorbell pre-warm of the Alexa egress transcode.
 *
 * The Echo asks for the stream 1.5 to 6 s AFTER the press is posted, and the
 * answer to its offer waits for the egress ffmpeg's first packet (~3 s cold).
 * A press for an exposed camera therefore acquires the egress right away, so
 * the offer finds a running child.
 *
 * The hold is a plain refcount holder with a hard deadline: it is released
 * after `holdMs` whether or not a session arrived (the manager's own release
 * grace then stops the child if nobody else holds it), and a session that does
 * arrive shares the same child because the sharing key is the request, which is
 * built from the same slot (`resolveAlexaSourceProfile`).
 */
import type { AddonApi, IScopedLogger } from '@camstack/types'
import type { ExposedDeviceEntry } from '../types.js'
import { acquireAlexaEgress, releaseAlexaEgress } from './alexa-rtc-egress.js'
import { resolveAlexaSourceProfile } from './alexa-source-profile.js'

/** How long a press keeps the transcode up when no session follows. */
export const ALEXA_PREWARM_HOLD_MS = 30_000

export interface AlexaEgressPrewarmDeps {
  readonly api: AddonApi
  readonly logger: IScopedLogger
  readonly listExposed: () => readonly ExposedDeviceEntry[]
  /** True while an Alexa session already holds an egress for the camera. */
  readonly hasLiveSession: (deviceId: number) => boolean
  readonly holdMs?: number
}

interface PrewarmHold {
  pipelineKey: string | null
  timer: NodeJS.Timeout | null
  /** Set when a session settled while the acquire was still in flight. */
  settledReason: string | null
}

/** What the offer handler tells the pre-warm once it knows what the session uses. */
export type AlexaSessionOutcome = 'attached' | 'bypassed-transcode'

/** The slice of the pre-warm the RTC session handler drives. */
export interface AlexaEgressPrewarmPort {
  /** An offer arrived for `deviceId`: warm the egress in parallel. Never throws. */
  onOffer(deviceId: number): Promise<void>
  /** The session took (or did not need) the egress; the hold has done its job. */
  onSession(deviceId: number, outcome: AlexaSessionOutcome): Promise<void>
}

const RELEASE_REASON_NO_SESSION = 'no session arrived'
const SESSION_REASON: Readonly<Record<AlexaSessionOutcome, string>> = {
  attached: 'session attached',
  'bypassed-transcode': 'session bypassed the transcode',
}

export class AlexaEgressPrewarm implements AlexaEgressPrewarmPort {
  private readonly holds = new Map<number, PrewarmHold>()
  private readonly holdMs: number
  private disposed = false

  constructor(private readonly deps: AlexaEgressPrewarmDeps) {
    this.holdMs = deps.holdMs ?? ALEXA_PREWARM_HOLD_MS
  }

  /** A doorbell press for `deviceId`. Never throws. */
  async onPress(deviceId: number): Promise<void> {
    await this.warm(deviceId, 'press')
  }

  /** An InitiateSessionWithOffer for `deviceId`: same hold as a press. Never throws. */
  async onOffer(deviceId: number): Promise<void> {
    await this.warm(deviceId, 'offer')
  }

  /**
   * The session handler settled: its own acquire holds the child now (or it
   * needs none), so the pre-warm's hold is released and says why.
   */
  async onSession(deviceId: number, outcome: AlexaSessionOutcome): Promise<void> {
    const hold = this.holds.get(deviceId)
    if (!hold) return
    const reason = SESSION_REASON[outcome]
    if (hold.pipelineKey === null) {
      // The acquire is still in flight: it releases itself when it lands.
      hold.settledReason = reason
      return
    }
    await this.release(deviceId, hold, reason)
  }

  private async warm(deviceId: number, trigger: 'press' | 'offer'): Promise<void> {
    const { api, logger } = this.deps
    if (this.disposed) return
    if (this.holds.has(deviceId)) {
      logger.debug('alexa egress prewarm: a hold is already pending, trigger ignored', {
        tags: { deviceId },
      })
      return
    }
    if (this.deps.hasLiveSession(deviceId)) {
      logger.info('alexa egress prewarm: an Alexa session is already live, nothing to warm', {
        tags: { deviceId },
      })
      return
    }
    // Reserved before the first await: two presses in one tick must not both
    // acquire.
    const hold: PrewarmHold = { pipelineKey: null, timer: null, settledReason: null }
    this.holds.set(deviceId, hold)
    const sessionId = `prewarm-${deviceId}-${Date.now()}`
    try {
      const exposedEntry = this.deps.listExposed().find((e) => e.deviceId === deviceId)
      const sourceProfile = await resolveAlexaSourceProfile({
        api,
        deviceId,
        exposedEntry,
        logger,
      })
      const acquired = await acquireAlexaEgress({
        api,
        deviceId,
        sourceProfile,
        sessionId,
        logger,
      })
      hold.pipelineKey = acquired.pipelineKey
      if (this.disposed || this.holds.get(deviceId) !== hold) {
        await this.release(deviceId, hold, 'disposed before the hold was armed')
        return
      }
      if (hold.settledReason !== null) {
        await this.release(deviceId, hold, hold.settledReason)
        return
      }
      hold.timer = setTimeout(() => {
        void this.release(deviceId, hold, RELEASE_REASON_NO_SESSION)
      }, this.holdMs)
      hold.timer.unref?.()
      logger.info('alexa egress prewarm: transcode held for the coming session', {
        tags: { deviceId },
        meta: {
          pipelineKey: acquired.pipelineKey,
          sourceProfile,
          holdMs: this.holdMs,
          trigger,
        },
      })
    } catch (err) {
      this.holds.delete(deviceId)
      logger.warn('alexa egress prewarm: acquire failed, the session will start the transcode', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /** Release every pending hold (addon shutdown). */
  async dispose(): Promise<void> {
    this.disposed = true
    const pending = [...this.holds.entries()]
    await Promise.all(pending.map(([deviceId, hold]) => this.release(deviceId, hold, 'shutdown')))
  }

  private async release(deviceId: number, hold: PrewarmHold, reason: string): Promise<void> {
    if (hold.timer) clearTimeout(hold.timer)
    hold.timer = null
    if (this.holds.get(deviceId) === hold) this.holds.delete(deviceId)
    const pipelineKey = hold.pipelineKey
    hold.pipelineKey = null
    if (pipelineKey === null) return
    await releaseAlexaEgress({
      api: this.deps.api,
      deviceId,
      pipelineKey,
      logger: this.deps.logger,
    })
    this.deps.logger.info('alexa egress prewarm: hold released', {
      tags: { deviceId },
      meta: { pipelineKey, reason },
    })
  }
}
