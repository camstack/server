/**
 * One pending wake-up per device — the timer half of the recorder's
 * event-driven convergence.
 *
 * `decision-schedule.ts` computes WHEN the live gate could change its answer;
 * this holds the single `setTimeout` that gets there, keyed by device, and
 * guarantees the invariants a hand-rolled `Map<number, Timeout>` keeps getting
 * wrong:
 *
 *  - **at most one timer per device.** Arming replaces, never stacks. A camera
 *    under continuous motion re-arms on every trigger; N triggers must not leave
 *    N timers behind, each firing a redundant `evaluateDevice` and each capable
 *    of racing an attach.
 *  - **never in the past, never zero.** A wake-up computed for an instant that
 *    has already passed fires on the next turn instead of synchronously, so an
 *    arm can never re-enter the code path that armed it.
 *  - **never longer than a `setTimeout` can express.** Past 2^31-1 ms Node
 *    truncates to 1 ms and the timer fires IMMEDIATELY, which would turn a
 *    far-future band edge into a hot loop. Clamped, and a clamped wake simply
 *    re-decides and re-arms.
 *  - **`unref`'d**, like every other recorder timer: convergence must never be
 *    the reason a runner refuses to exit.
 *
 * The registry does no deciding of its own. `fire` is expected to re-evaluate
 * the device, which re-arms (or cancels) as a side effect — so a lost or
 * mis-computed wake-up costs one turn, not a stuck device, and the periodic
 * reconcile remains the backstop for both.
 */
import type { IScopedLogger } from '@camstack/types'

/** Node truncates a `setTimeout` delay past this to 1 ms — clamp instead. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Floor for a wake-up delay: a due-or-overdue instant fires on the NEXT turn. */
export const MIN_TIMER_DELAY_MS = 1

export interface DeviceWakeupsDeps {
  readonly logger: Pick<IScopedLogger, 'debug'>
  readonly now: () => number
  /** Re-evaluate one device. Must not throw synchronously. */
  readonly fire: (deviceId: number) => void
}

export class DeviceWakeups {
  private readonly timers = new Map<number, NodeJS.Timeout>()

  constructor(private readonly deps: DeviceWakeupsDeps) {}

  /**
   * Wake this device at `atMs`, replacing any wake-up already armed for it.
   * `reason` is carried into the log line so a wake is attributable without
   * correlating it against the band model by hand.
   */
  arm(deviceId: number, atMs: number, reason: string): void {
    this.cancel(deviceId)
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(MIN_TIMER_DELAY_MS, atMs - this.deps.now()),
    )
    const timer = setTimeout(() => {
      this.timers.delete(deviceId)
      this.deps.fire(deviceId)
    }, delayMs)
    timer.unref?.()
    this.timers.set(deviceId, timer)
    this.deps.logger.debug('recorder: device wake-up armed', {
      tags: { deviceId },
      meta: { atMs, delayMs, reason },
    })
  }

  /** Drop this device's pending wake-up, if any. Idempotent. */
  cancel(deviceId: number): void {
    const timer = this.timers.get(deviceId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(deviceId)
  }

  /** Drop every pending wake-up — shutdown and maintenance pause. */
  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** Devices with a wake-up pending — for tests and for shutdown assertions. */
  get pendingCount(): number {
    return this.timers.size
  }
}
