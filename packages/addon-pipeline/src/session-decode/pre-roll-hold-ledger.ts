/**
 * What became of the PRE-ROLL frames a burst delivered (D652).
 *
 * A pre-roll frame delivered to the runner is a promise: the worker holds its
 * pixels until the runner's lane reaches it and reads it. The lane is served
 * only when live work leaves a permit spare, oldest first, so a frame can be
 * lost AFTER the burst's own report has gone out — evicted by the hold, cleared
 * by a re-dial, never downloaded, or simply gone when the read arrives. That
 * loss used to surface only as a per-frame `toBuffer miss` line, with nothing
 * tying it to the burst that caused it.
 *
 * The burst's report is still sent at burst end, unchanged in timing. This
 * tracker produces the SECOND line: once every delivered pre-roll frame has
 * settled — or on teardown, with what is still unsettled — exactly once.
 *
 * Pure bookkeeping keyed by worker frameId, no clock, no I/O: the worker
 * feeds it from the seams where a frame's life ends and sends what it returns.
 */
import type { PreRollLossReason, WorkerPreRollSettled } from './worker-protocol.js'

/** How one delivered pre-roll frame's life ended. */
export type PreRollSettleOutcome = 'read' | 'released' | PreRollLossReason

export class PreRollSettleTracker {
  private readonly pending = new Set<number>()
  private read = 0
  private released = 0
  private readonly lost: Record<PreRollLossReason, number> = {
    evicted: 0,
    cleared: 0,
    'download-failed': 0,
    miss: 0,
  }
  private burstEnded = false
  private emitted = false

  /** A pre-roll frame was delivered to the runner; inference has not read it yet. */
  admit(frameId: number): void {
    if (this.emitted) return
    this.pending.add(frameId)
  }

  /**
   * One frame's fate. Only the FIRST outcome of a delivered pre-roll frame
   * counts: a miss that follows an eviction is the same loss, not two. Returns
   * the summary to send when this settle was the last one owed after the burst
   * ended, else `null`.
   */
  settle(frameId: number, outcome: PreRollSettleOutcome): WorkerPreRollSettled | null {
    if (!this.pending.delete(frameId)) return null
    if (outcome === 'read') this.read += 1
    else if (outcome === 'released') this.released += 1
    else this.lost[outcome] += 1
    return this.summaryIfSettled()
  }

  /** Every frame still pending is lost the same way at once (a re-dial clearing the hold). */
  settleAll(outcome: PreRollLossReason): WorkerPreRollSettled | null {
    let summary: WorkerPreRollSettled | null = null
    // The last settle is the one that produces the summary — keep it.
    for (const frameId of [...this.pending]) summary = this.settle(frameId, outcome) ?? summary
    return summary
  }

  /** The burst is over: from now on the summary goes out when nothing is owed. */
  endBurst(): WorkerPreRollSettled | null {
    this.burstEnded = true
    return this.summaryIfSettled()
  }

  /**
   * Teardown: send what is known now, `unsettled` included. `null` when there
   * was no burst or the summary already went out.
   */
  flush(): WorkerPreRollSettled | null {
    if (this.emitted || !this.burstEnded) return null
    return this.emit()
  }

  private summaryIfSettled(): WorkerPreRollSettled | null {
    if (this.emitted || !this.burstEnded || this.pending.size > 0) return null
    return this.emit()
  }

  private emit(): WorkerPreRollSettled {
    this.emitted = true
    return {
      read: this.read,
      released: this.released,
      lostByReason: { ...this.lost },
      unsettled: this.pending.size,
    }
  }
}
