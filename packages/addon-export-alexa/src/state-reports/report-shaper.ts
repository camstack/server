/**
 * Rate shaping for proactive reports (D869).
 *
 * A temperature sensor that twitches 0.1 °C every few seconds, or a blind that
 * streams its position while the motor runs, must not become a stream of
 * ChangeReports to Amazon. Three rules, per property (`PropertyShaping`):
 *
 *   - deadband      a numeric change smaller than this is not a change
 *   - minIntervalMs at most one report per interval; while waiting, the newest
 *                   value replaces the pending one and goes out at the end
 *   - debounceMs    an actuator in motion reports its FINAL value: every new
 *                   value restarts the quiet period
 *
 * A value with none of the three goes straight out. The shaper only decides
 * WHEN (and whether) to call `send`; what was sent and the dedupe of an
 * unchanged value stay with the reporter.
 */
import type { PropertyShaping } from '../endpoints/adapters/types.js'

type TimerHandle = ReturnType<typeof setTimeout>

export interface ShaperClock {
  readonly now: () => number
  readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimer: (handle: TimerHandle) => void
}

const REAL_CLOCK: ShaperClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return handle
  },
  clearTimer: (handle) => {
    clearTimeout(handle)
  },
}

interface Pending<R> {
  readonly report: R
  readonly value: number | null
  readonly shaping: PropertyShaping
  readonly send: (report: R) => Promise<void>
}

interface KeyState<R> {
  lastValue: number | null
  lastSentAt: number | null
  timer: TimerHandle | null
  pending: Pending<R> | null
}

export class ReportShaper<R> {
  private readonly keys = new Map<string, KeyState<R>>()

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly clock: ShaperClock = REAL_CLOCK,
  ) {}

  private stateOf(key: string): KeyState<R> {
    let state = this.keys.get(key)
    if (state === undefined) {
      state = { lastValue: null, lastSentAt: null, timer: null, pending: null }
      this.keys.set(key, state)
    }
    return state
  }

  /** Whether a value for `key` is waiting for its turn. */
  hasPending(key: string): boolean {
    return this.keys.get(key)?.pending != null
  }

  /** Record what Alexa is known to hold, without sending (a reconcile baseline
   *  or a report sent outside the shaper). */
  markSent(key: string, value: number | null): void {
    const state = this.stateOf(key)
    state.lastValue = value
    state.lastSentAt = this.clock.now()
  }

  /** The numeric value last sent for `key`. */
  lastValue(key: string): number | null {
    return this.keys.get(key)?.lastValue ?? null
  }

  /** Offer a new value; `send` is called now or later, or never (deadband). */
  async submit(
    key: string,
    report: R,
    shaping: PropertyShaping,
    value: number | null,
    send: (report: R) => Promise<void>,
  ): Promise<void> {
    const state = this.stateOf(key)
    this.cancelTimer(state)
    if (this.insideDeadband(state, shaping, value)) {
      state.pending = null
      return
    }
    state.pending = { report, value, shaping, send }
    const delay = this.delayFor(state, shaping)
    if (delay <= 0) {
      await this.fire(state)
      return
    }
    state.timer = this.clock.setTimer(() => {
      void this.fire(state)
    }, delay)
  }

  private insideDeadband(
    state: KeyState<R>,
    shaping: PropertyShaping,
    value: number | null,
  ): boolean {
    return (
      shaping.deadband !== undefined &&
      value !== null &&
      state.lastValue !== null &&
      Math.abs(value - state.lastValue) < shaping.deadband
    )
  }

  private delayFor(state: KeyState<R>, shaping: PropertyShaping): number {
    const debounce = shaping.debounceMs ?? 0
    const interval =
      shaping.minIntervalMs !== undefined && state.lastSentAt !== null
        ? state.lastSentAt + shaping.minIntervalMs - this.clock.now()
        : 0
    return Math.max(debounce, interval)
  }

  private async fire(state: KeyState<R>): Promise<void> {
    state.timer = null
    const pending = state.pending
    state.pending = null
    if (pending === null) return
    // The value that was last SENT may have moved since this one queued.
    if (this.insideDeadband(state, pending.shaping, pending.value)) return
    state.lastValue = pending.value ?? state.lastValue
    state.lastSentAt = this.clock.now()
    try {
      await pending.send(pending.report)
    } catch (err) {
      this.onError(err)
    }
  }

  private cancelTimer(state: KeyState<R>): void {
    if (state.timer !== null) {
      this.clock.clearTimer(state.timer)
      state.timer = null
    }
  }

  /** Drop every pending report and timer. */
  stop(): void {
    for (const state of this.keys.values()) {
      this.cancelTimer(state)
      state.pending = null
    }
    this.keys.clear()
  }
}
