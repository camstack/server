/**
 * Tuning constants for the emulated PTZ autotrack.
 *
 * Everything here is a number the OPERATOR does not set: the dead zone, the
 * settle zone, the command ceiling, the pulse dead time, the refresh cadences.
 * D520 kept them out of the settings surface on purpose — they are the
 * behaviour of the control loop, not a preference, and a camera whose dead zone
 * somebody widened by hand is a camera nobody can reason about.
 *
 * What IS per camera lives with the record (`autotrack-cameras.ts`): the switch,
 * the target class and the disappear delay, all read through the cap's own
 * settings so there is one place an operator changes them.
 */

/**
 * ## The constants that used to live here
 *
 * `AUTOTRACK_ARMED` and `AUTOTRACK_TARGET_DEVICE_ID` were the whole protection
 * of the measurement slice: arming was a deploy-shaped act because there was no
 * switch to do it with. There is one now — the emulation registers
 * `ptz-autotrack` as a wrapper the operator BINDS per camera and switches on
 * through the cap's own `setEnabled` (D62: one function, one switch). The
 * protection is no longer a constant; it is that a camera must be both bound
 * and switched on, and that the loop still refuses to move without
 * `moveImpulseMs` or while the camera's native autotrack is armed (D520).
 *
 * `AUTOTRACK_TARGET_CLASS` went the same way: the class is per camera now,
 * from the cap's `targetType` setting (`autotrack-cameras.ts`).
 */

/** Signed single-axis step handed to `ptz.move` — a DIRECTION, not a delta.
 *  Every provider reads the sign and ignores the magnitude (reolink:
 *  `pan > 0 ? 'Right' : 'Left'`), so only -1 / 0 / +1 are meaningful. */
export type PtzAxisStep = -1 | 0 | 1

/** Tuning of the control loop. Every field is a time or a fraction; nothing
 *  here is derived from `detectionFps` — see {@link maxCommandsPerSecond}. */
export interface AutotrackLoopConfig {
  /**
   * Width/height of the central "do nothing" box, as a fraction of the frame.
   * `0.5` = the central 50%: a correction starts only once the subject's
   * centre leaves it (|error| > 0.25 on that axis).
   */
  readonly deadZoneFraction: number
  /**
   * Width/height of the TIGHTER box that ENDS a correction, as a fraction of
   * the frame. Must be smaller than {@link deadZoneFraction}.
   *
   * This is the anti-overshoot rule: the loop stops correcting BEFORE the
   * subject reaches the centre. Aiming at the centre with an estimated gain
   * overshoots, and an overshoot on the next frame reverses the sign — that is
   * the oscillation this box exists to prevent.
   */
  readonly settleZoneFraction: number
  /**
   * Hard ceiling on commands issued to the camera, in commands per second,
   * owned by the LOOP.
   *
   * Explicitly NOT derived from the analysis rate. `frame-tracked` arrives at
   * 1–10 Hz; at 10 Hz a per-frame command would be ~10 commands/s, an order of
   * magnitude above what the hardware takes. The ceiling is measured, in-repo:
   * a Reolink E1 Outdoor PoE rejects a command issued while the previous one
   * is still travelling with `response_code 400` — presses 1.2 s apart were
   * REJECTED, 3 s apart were ACCEPTED (`reolink-camera.ts`, `runZoom`). `1/3`
   * is that 3 s, and it is the gate that binds in practice.
   */
  readonly maxCommandsPerSecond: number
  /**
   * Extra silence after a pulse is expected to have FINISHED, ms.
   *
   * The dead time after a command is `moveImpulseMs + pulseSettleMs`: the head
   * is still travelling for the first part and the detector has not yet seen
   * the new framing for the second. Commanding inside it measures an error
   * that the in-flight pulse has already corrected.
   */
  readonly pulseSettleMs: number
  /**
   * How long the chosen target may be absent before it is released and the
   * head is sent home, ms. Also the silence watchdog's budget: if
   * `frame-tracked` stops arriving entirely, the same delay elapses and the
   * same release happens — off the event path, by timer.
   */
  readonly disappearDelayMs: number
  /** Normalized speed (0..1) handed to `ptz.move`. */
  readonly speed: number
  /** How often the off-event-path mirror re-reads `ptz.getOptions` and the
   *  native-autotrack state, ms. Never on the event path (D49). */
  readonly mirrorRefreshMs: number
  /** How often the measurement aggregates are summarized to the log, ms. */
  readonly measurementSummaryMs: number
}

export const DEFAULT_AUTOTRACK_LOOP_CONFIG: AutotrackLoopConfig = {
  deadZoneFraction: 0.5,
  settleZoneFraction: 0.3,
  maxCommandsPerSecond: 1 / 3,
  pulseSettleMs: 400,
  disappearDelayMs: 15_000,
  speed: 0.4,
  mirrorRefreshMs: 30_000,
  measurementSummaryMs: 30_000,
}
