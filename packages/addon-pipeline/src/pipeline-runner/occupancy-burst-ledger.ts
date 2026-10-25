/**
 * When an occupancy burst is COMPLETE (D652).
 *
 * A burst collects a handful of frames from a still scene and asks one
 * question of them: is anything still there? The answer is read off the
 * results — `onResult` sets `occupancyBurstFound` for a burst in flight — so a
 * burst that reports before its frames are inferred answers from whatever
 * happened to finish first. The dial path did exactly that: it enqueued its 4th
 * frame and reported in the same synchronous turn, and killed the decode worker
 * those four lazy frames lived in while doing it. Measured live: 122 of 187
 * bursts lost at least one frame, and nothing said so.
 *
 * So a burst completes when every frame it ADMITTED has SETTLED — the runner
 * inferred it (after its result callbacks ran), or let it go without a result
 * (superseded on the latest-only queue, cleared by a detach, failed) — and
 * admission has closed. A frame that never settles cannot pin the burst: the
 * bound completes it and counts that frame as lost.
 *
 * Pure bookkeeping, no clock but the injected timer, no I/O: the owner decides
 * what "complete" triggers (the verdict, the log line).
 */
import type { FrameSettleOutcome } from './runner.js'

/** How a burst ended — the numbers its `burst complete` line reports. */
export interface OccupancyBurstSummary {
  /** Frames the burst collected (admitted or refused by the runner). */
  readonly frames: number
  /** Frames that reached a result the verdict could see. */
  readonly inferred: number
  /**
   * Frames a NEWER frame of the same burst replaced on the latest-only queue.
   * The queue's design, not a loss: the verdict saw a later look at the scene.
   */
  readonly superseded: number
  /**
   * `frames - inferred - superseded`: frames the verdict did not see and no
   * later frame stood in for — refused, cleared, failed, answered with
   * nothing, or never settled.
   */
  readonly lost: number
  /** Of `lost`, frames still unsettled when the bound expired. */
  readonly unsettled: number
  /** True when the bound, not the last settle, completed the burst. */
  readonly timedOut: boolean
}

/** Settle one admitted frame with how it ended. Idempotent. */
export type BurstFrameSettler = (outcome: FrameSettleOutcome) => void

export interface OccupancyBurstLedgerOptions {
  /** Longest a closed burst waits for its admitted frames to settle. */
  readonly settleBoundMs: number
  readonly onComplete: (summary: OccupancyBurstSummary) => void
}

export class OccupancyBurstLedger {
  private frames = 0
  private inferred = 0
  private superseded = 0
  private settled = 0
  private closed = false
  private completed = false
  private boundTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: OccupancyBurstLedgerOptions) {}

  /**
   * Count one collected frame and hand back its settler. A frame the runner
   * REFUSED is settled `'lost'` by the caller at once — it is a frame the
   * verdict did not see, which is what `lost` counts.
   */
  admit(): BurstFrameSettler {
    this.frames += 1
    let done = false
    return (outcome: FrameSettleOutcome): void => {
      if (done || this.completed) return
      done = true
      this.settled += 1
      if (outcome === 'inferred') this.inferred += 1
      else if (outcome === 'superseded') this.superseded += 1
      this.completeIfSettled()
    }
  }

  /**
   * No more frames will be collected (count reached, safety timeout, or the
   * decode ended). Completes now when everything admitted has settled, else
   * arms the bound. Idempotent.
   */
  close(): void {
    if (this.closed || this.completed) return
    this.closed = true
    if (this.completeIfSettled()) return
    this.boundTimer = setTimeout(() => {
      this.boundTimer = null
      this.complete(true)
    }, this.options.settleBoundMs)
    this.boundTimer.unref?.()
  }

  private completeIfSettled(): boolean {
    if (!this.closed || this.settled < this.frames) return false
    this.complete(false)
    return true
  }

  private complete(timedOut: boolean): void {
    if (this.completed) return
    this.completed = true
    if (this.boundTimer !== null) {
      clearTimeout(this.boundTimer)
      this.boundTimer = null
    }
    this.options.onComplete({
      frames: this.frames,
      inferred: this.inferred,
      superseded: this.superseded,
      lost: this.frames - this.inferred - this.superseded,
      unsettled: this.frames - this.settled,
      timedOut,
    })
  }
}
