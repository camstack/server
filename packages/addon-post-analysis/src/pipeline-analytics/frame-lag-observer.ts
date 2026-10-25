/**
 * frame-lag-observer — tells STARVED apart from WAITING, and nothing else.
 *
 * ## The question this exists to answer
 *
 * `pipeline-analytics` is ONE process serving every camera, and it goes silent
 * for 10+ seconds at a time. Measured 2026-09-09: a 10.0 s silence
 * (06:10:57.070 → 06:11:07.075) followed by 138 log lines inside one second,
 * and in a 54-minute window gaps >=5 s occurred 28 times, >=10 s twice, once
 * 30.4 s — roughly three 10-second silences an hour. Four of that morning's
 * eight operator debug marks have no other explanation: 17 positions all
 * processed 13.5 s late, `capture batch lost — frame recycled before resolve`
 * x12, a door contact projected 20.8 s after the event, and a notification
 * shipping `dropped: ["gif"]` because its footage window expired while queued.
 *
 * Two mechanisms produce that EXACT signature — a silence, then a burst-drain —
 * and until this module landed nothing in the system could tell them apart:
 *
 *  - **starved**: the inference events arrived late from the runner / hub-main.
 *    Analytics was idle and innocent; the fix belongs upstream.
 *  - **waiting**: the events arrived on time and the stall is inside
 *    `processFrame` (`RawGlobalStoreMirror.resolve()` is the first suspect —
 *    it is the one cross-camera serializer on the frame path).
 *
 * What is already ruled out, and must not be re-litigated from these numbers:
 * the event loop is NOT blocked wholesale. The 5-minute `[mem]` timer fired at
 * dt = 300020 / 300066 / 299991 ms straight through the silences, `loopMax`
 * 29–42 ms.
 *
 * ## How to read the numbers this produces
 *
 *  - `busLagMaxMs` ~ 13 000 → **STARVED**. The runner or hub-main delivered
 *    late; analytics is innocent and the fix belongs upstream.
 *  - `busLagMaxMs` ~ 0 while positions still land 13 s late → **WAITING**. The
 *    stall is inside `processFrame`, and `RawGlobalStoreMirror` is the first
 *    place to look.
 *
 * **Never read an ABSOLUTE busLag as latency.** `emittedAt` is stamped on the
 * RUNNER's node and `now` is read here; the difference carries that node's
 * clock offset, and this fleet has shipped a clock regression as recently as
 * last night. What is trustworthy is the DELTA against the same camera's own
 * baseline — a device whose busLag sits at 40 ms for an hour and spikes to
 * 10 000 ms for one window is starved, whatever its offset. `busLagMinMs` is
 * carried for exactly this reason: a constant offset shows up as a min and a
 * max that move together and never approach zero.
 *
 * ## Why an aggregate and not a per-frame line
 *
 * This is the busiest path in the system: ~672 frames/s (12 cameras x 56
 * frames/10 s). A per-frame line is not instrumentation, it is a second
 * outage. So each device accumulates into a window and emits ONE line per
 * {@link LAG_WINDOW_MS} — 24 lines/min fleet-wide — carrying the window's
 * WORST lag, which is the only statistic a burst-drain cannot hide. A mean
 * would average a 10 s spike into 300 frames of healthy traffic and report
 * 33 ms.
 *
 * The first frame of each device reports immediately: an instrument whose
 * first evidence is 30 s away cannot be distinguished from one that was never
 * deployed.
 *
 * Per frame this costs one `Map.get`, ~10 numeric ops and no allocation:
 * ~20 ns measured (200 000 calls in ~4 ms), which at 672 frames/s is ~13 us of
 * CPU per wall-clock second — 0.0013% of one core. The spec asserts a 1 us
 * ceiling rather than the measured figure (CI is noisy) and fails if the cost
 * ever moves into a range that could itself cause a stall.
 *
 * ## D8: unknown is not zero
 *
 * The bus is telemetry and may drop events, and during a rolling deploy an
 * older runner emits a payload with NO `emittedAt` at all — that is the normal
 * case, not an error. An absent stamp counts into `busLagUnknownFrames` and
 * leaves `busLagMaxMs` null. It must never be folded in as 0: a fabricated 0
 * reads as "delivered instantly", which is the exact verdict (WAITING) this
 * module exists to establish honestly.
 */

/** One device's window, closed and reported. */
export interface FrameLagReport {
  readonly deviceId: number
  /** Frames folded into this window (including the one that closed it). */
  readonly frames: number
  /** Worst `now - emittedAt` in the window. Null ⇒ no frame carried a stamp. */
  readonly busLagMaxMs: number | null
  /** Best `now - emittedAt` in the window — a constant remote clock offset
   *  moves this and `busLagMaxMs` together. Null ⇒ no frame carried a stamp. */
  readonly busLagMinMs: number | null
  /** Frames whose payload carried no `emittedAt` (older runner, or dropped). */
  readonly busLagUnknownFrames: number
  /** Worst `now - capturedAt` in the window. Null ⇒ no frame carried a stamp. */
  readonly captureLagMaxMs: number | null
  /** Frames whose payload carried no `capturedAt`. */
  readonly captureLagUnknownFrames: number
  /** Wall-clock span the window actually covered (ms). */
  readonly windowMs: number
}

/**
 * One line per device per 30 s. Chosen against the signal, not against taste:
 * the silences are 10–30 s and recur ~3x/hour, so a 30 s window cannot hide
 * one (the max survives the aggregation) while keeping the fleet at 24
 * lines/min — a rounding error next to what this addon already logs.
 */
export const LAG_WINDOW_MS = 30_000

/**
 * Lag at or past this makes the window's line a `warn` rather than an `info`.
 * 5 s is the smallest gap the 2026-09-09 forensics counted as an episode (28
 * of them in 54 minutes) and is ~10x the healthy per-frame budget, so it never
 * fires on ordinary jitter.
 */
export const LAG_ALARM_MS = 5_000

/**
 * What one window says about the two candidate mechanisms.
 *
 *  - `starved` — the events reached this process late. Analytics is innocent
 *    for that window; the fix belongs to the runner or hub-main.
 *  - `delivered-on-time` — delivery was prompt. If work still landed seconds
 *    late in the same window, the stall is INSIDE `processFrame`, and
 *    `RawGlobalStoreMirror.resolve()` is the first place to look.
 *  - `unknown` — no frame in the window carried an `emittedAt` (older runner,
 *    or the stamps were dropped). Says nothing. Deliberately not folded into
 *    `delivered-on-time`: that would be the fabricated verdict D8 forbids, and
 *    it is the one that sends the next session down the wrong path.
 */
export type LagVerdict = 'starved' | 'delivered-on-time' | 'unknown'

/** Read the window. Pure — this is the judgement the module exists to make. */
export function lagVerdict(report: FrameLagReport): LagVerdict {
  const bus = report.busLagMaxMs
  if (bus === null) return 'unknown'
  return bus >= LAG_ALARM_MS ? 'starved' : 'delivered-on-time'
}

/** Does this window need an operator's eyes? Unknown never counts as alarming
 *  — that is the fabricated verdict D8 forbids. */
export function isAlarmingLagReport(report: FrameLagReport): boolean {
  const bus = report.busLagMaxMs
  const capture = report.captureLagMaxMs
  return (bus !== null && bus >= LAG_ALARM_MS) || (capture !== null && capture >= LAG_ALARM_MS)
}

/** Mutable per-device accumulator. Deliberately not readonly: this is the one
 *  place in the frame path where allocating a fresh object per frame would
 *  cost more than the measurement is worth. */
interface LagWindow {
  startedAt: number
  frames: number
  busMax: number | null
  busMin: number | null
  busUnknown: number
  captureMax: number | null
  captureUnknown: number
}

/**
 * Folds per-frame delivery lag into per-device windows.
 *
 * Not a logger: it returns the line to write (or null) and the caller decides
 * level and tags. That keeps the throttle — the part that can wreck the frame
 * path — testable without a logger fake.
 */
export class FrameLagObserver {
  private readonly windows = new Map<number, LagWindow>()

  /**
   * Fold one inference result into `deviceId`'s window.
   *
   * @param now Receipt time, read by the caller once at handler entry.
   * @param emittedAt Runner-side emit stamp; undefined ⇒ unknown (D8).
   * @param capturedAt Frame shm-commit stamp; undefined ⇒ unknown.
   * @returns The closed window when this frame ends one, else null.
   */
  observe(
    deviceId: number,
    now: number,
    emittedAt: number | undefined,
    capturedAt: number | undefined,
  ): FrameLagReport | null {
    const existing = this.windows.get(deviceId)
    // A device's very first frame opens AND closes a window, so the instrument
    // announces itself the moment a camera starts flowing.
    const w: LagWindow = existing ?? {
      startedAt: now,
      frames: 0,
      busMax: null,
      busMin: null,
      busUnknown: 0,
      captureMax: null,
      captureUnknown: 0,
    }
    if (existing === undefined) this.windows.set(deviceId, w)

    w.frames += 1
    if (typeof emittedAt === 'number') {
      const busLag = now - emittedAt
      if (w.busMax === null || busLag > w.busMax) w.busMax = busLag
      if (w.busMin === null || busLag < w.busMin) w.busMin = busLag
    } else {
      w.busUnknown += 1
    }
    if (typeof capturedAt === 'number') {
      const captureLag = now - capturedAt
      if (w.captureMax === null || captureLag > w.captureMax) w.captureMax = captureLag
    } else {
      w.captureUnknown += 1
    }

    if (existing !== undefined && now - w.startedAt < LAG_WINDOW_MS) return null

    const report: FrameLagReport = {
      deviceId,
      frames: w.frames,
      busLagMaxMs: w.busMax,
      busLagMinMs: w.busMin,
      busLagUnknownFrames: w.busUnknown,
      captureLagMaxMs: w.captureMax,
      captureLagUnknownFrames: w.captureUnknown,
      windowMs: now - w.startedAt,
    }
    w.startedAt = now
    w.frames = 0
    w.busMax = null
    w.busMin = null
    w.busUnknown = 0
    w.captureMax = null
    w.captureUnknown = 0
    return report
  }

  /** Drop a device's window (unbound camera, shutdown). */
  forget(deviceId: number): void {
    this.windows.delete(deviceId)
  }

  /** Drop every window. */
  clear(): void {
    this.windows.clear()
  }
}
