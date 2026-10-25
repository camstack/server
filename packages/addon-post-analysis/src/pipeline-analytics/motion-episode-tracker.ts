/**
 * Stateful orchestration around {@link decideMotionSignal} (D475): owns the
 * per-`(deviceId, source)` map and the wall-clock close timers, and calls out
 * to the injected `insertRow` / `closeRow` for the actual persistence.
 *
 * Kept separate from `motion-episode.ts` on purpose — that module is pure and
 * tested without a clock; this one is the only place that touches
 * `setTimeout` and awaits a store call, so a test of ITS behaviour is a test
 * of timing and sequencing, not of the decision table.
 */
import type { IScopedLogger, MotionSource } from '@camstack/types'
import {
  decideMotionSignal,
  motionEpisodeDurationMs,
  type MotionEpisodeOpenState,
} from './motion-episode.js'

export interface MotionEpisodeInsertInput<TRegionData> {
  readonly deviceId: number
  readonly source: MotionSource
  readonly timestamp: number
  /** The kind-specific fields the two motion handlers differ on (regions,
   *  frameWidth, frameHeight, …) — opaque to the tracker, forwarded verbatim
   *  from `observe`'s caller to `insertRow`. Only read on the FIRST edge of
   *  an episode; a further edge inside an already-open one has nowhere to
   *  put a second set of regions (one row, one INSERT). */
  readonly regionData: TRegionData
}

export interface MotionEpisodeCloseInput {
  readonly deviceId: number
  readonly source: MotionSource
  readonly eventId: number
  readonly durationMs: number
  readonly edges: readonly number[]
}

export interface MotionEpisodeEdgeInput {
  readonly deviceId: number
  readonly source: MotionSource
  readonly timestamp: number
  /** The row this edge belongs to — the SAME id on every edge of one
   *  episode, since only the first edge inserts a row. */
  readonly eventId: number
  /** True on the episode's very first edge (the caller used to call this
   *  `transitionedOn`); false on a further edge inside an already-open
   *  episode. */
  readonly isFirst: boolean
}

export interface MotionEpisodeTickInput {
  readonly deviceId: number
  readonly source: MotionSource
  readonly timestamp: number
}

export interface MotionEpisodeTrackerDeps<TRegionData> {
  readonly closeAfterMs: number
  readonly logger: IScopedLogger
  /** Insert the row that opens a new episode. `null` means the write failed
   *  (already logged by the store) — the tracker opens nothing and retries
   *  on the next rising edge, exactly like every other insert path in this
   *  addon (D474). */
  readonly insertRow: (input: MotionEpisodeInsertInput<TRegionData>) => Promise<number | null>
  /** UPDATE the row at close with the final `durationMs` + `edges`. Returns
   *  whether it landed; a `false` is logged here with the episode's own
   *  `deviceId` tag (D475 logging rule) — the store already logs its own
   *  failure, this is the "the episode never got its close" half. */
  readonly closeRow: (input: MotionEpisodeCloseInput) => Promise<boolean>
  /** Fired on a genuine off→on transition — open or a further edge inside an
   *  open episode. Drives the birth-latency onset mark + the motion-marker
   *  still, which the ORIGINAL code fired on every `transitionedOn`. */
  readonly onNewEdge?: (input: MotionEpisodeEdgeInput) => void
  /** Fired on every `detected:true` observation that reaches an open or
   *  newly-opened episode — transition or continuation. Drives the
   *  scene-engine quiet-edge arm and the motion-activity LTS sample, both of
   *  which want "motion is still happening", not "a new edge happened". */
  readonly onTick?: (input: MotionEpisodeTickInput) => void
}

interface TrackedSignal {
  readonly deviceId: number
  readonly source: MotionSource
  lastDetected: boolean
  episode: MotionEpisodeOpenState | null
}

function keyOf(deviceId: number, source: MotionSource): string {
  return `${deviceId}:${source}`
}

export class MotionEpisodeTracker<TRegionData> {
  private readonly signals = new Map<string, TrackedSignal>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: MotionEpisodeTrackerDeps<TRegionData>) {}

  /**
   * One `(detected, timestamp)` observation for one `(deviceId, source)` key.
   * `regionData` is read only if this observation OPENS a new episode — see
   * {@link MotionEpisodeInsertInput}.
   */
  async observe(
    deviceId: number,
    source: MotionSource,
    detected: boolean,
    timestamp: number,
    regionData: TRegionData,
  ): Promise<void> {
    const key = keyOf(deviceId, source)
    const prior = this.signals.get(key)
    const decision = decideMotionSignal(prior, detected, timestamp)

    switch (decision.kind) {
      case 'noop':
        return
      case 'observed-off':
        this.setSignal(key, deviceId, source, false, prior?.episode ?? null)
        return
      case 'open-episode': {
        const eventId = await this.deps.insertRow({ deviceId, source, timestamp, regionData })
        if (eventId === null) {
          // A branch that drops work logs it (CLAUDE.md) — the store already
          // logged the write failure with this deviceId; this line is the
          // consequence: no episode opened, the next rising edge retries.
          this.deps.logger.warn('motion episode open failed — insert did not land', {
            tags: { deviceId },
            meta: { source, timestamp },
          })
          this.setSignal(key, deviceId, source, true, null)
          return
        }
        const episode: MotionEpisodeOpenState = {
          eventId,
          startedAt: timestamp,
          lastOnAt: timestamp,
          edgeOffsetsMs: [0],
        }
        this.setSignal(key, deviceId, source, true, episode)
        this.armCloseTimer(key)
        this.deps.onNewEdge?.({ deviceId, source, timestamp, eventId, isFirst: true })
        this.deps.onTick?.({ deviceId, source, timestamp })
        return
      }
      case 'extend-episode': {
        this.setSignal(key, deviceId, source, true, decision.next)
        this.armCloseTimer(key)
        if (decision.isNewEdge) {
          this.deps.onNewEdge?.({
            deviceId,
            source,
            timestamp,
            eventId: decision.next.eventId,
            isFirst: false,
          })
        }
        this.deps.onTick?.({ deviceId, source, timestamp })
        return
      }
    }
  }

  /**
   * Close every currently-open episode immediately, without waiting out the
   * quiet window — used at addon shutdown so a row never sits with
   * `durationMs: null` forever because the process that would have closed it
   * is gone. Each close is logged with `reason` so an operator reading the
   * row's neighbours understands why it stopped short of a natural close.
   */
  async closeAll(reason: string): Promise<void> {
    const keys = [...this.signals.keys()]
    for (const key of keys) {
      const signal = this.signals.get(key)
      if (!signal?.episode) continue
      await this.closeNow(key, signal, reason)
    }
  }

  private setSignal(
    key: string,
    deviceId: number,
    source: MotionSource,
    lastDetected: boolean,
    episode: MotionEpisodeOpenState | null,
  ): void {
    this.signals.set(key, { deviceId, source, lastDetected, episode })
  }

  private armCloseTimer(key: string): void {
    const existing = this.timers.get(key)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      void this.fireClose(key)
    }, this.deps.closeAfterMs)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  private async fireClose(key: string): Promise<void> {
    this.timers.delete(key)
    const signal = this.signals.get(key)
    if (!signal?.episode) return
    await this.closeNow(key, signal, 'quiet-window-elapsed')
  }

  private async closeNow(key: string, signal: TrackedSignal, reason: string): Promise<void> {
    const episode = signal.episode
    if (!episode) return
    const timer = this.timers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
    // Clear the episode BEFORE the await — a rising edge arriving while the
    // close write is in flight must open a fresh episode, not extend the one
    // that is already on its way out.
    signal.episode = null
    const durationMs = motionEpisodeDurationMs(episode)
    const landed = await this.deps.closeRow({
      deviceId: signal.deviceId,
      source: signal.source,
      eventId: episode.eventId,
      durationMs,
      edges: episode.edgeOffsetsMs,
    })
    if (!landed) {
      this.deps.logger.warn('motion episode close failed — row keeps durationMs: null', {
        tags: { deviceId: signal.deviceId },
        meta: { source: signal.source, eventId: episode.eventId, reason },
      })
    }
  }
}
