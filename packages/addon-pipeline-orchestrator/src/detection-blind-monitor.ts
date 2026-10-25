/**
 * DetectionBlindMonitor — "this camera MOVED, is being analysed, and the
 * detector produced nothing at all" (D907, amending D906's recovery semantics).
 *
 * ## The failure
 *
 * On the entrance camera, detection produced nothing for 1h43 and nobody
 * noticed: device, stream, node and watchdog were all healthy and the only
 * thing missing was the detections. A camera that detects nothing is
 * byte-identical to a camera with nothing to detect.
 *
 * ## Why wall time was the wrong clock (D907)
 *
 * The first version said "frames arriving AND no detection for 60 wall
 * minutes". Every camera that alerted in production is session-dispatched on
 * onboard motion, so frames exist only while something moved. 122 alerts in
 * three days, none of them blindness: 44 were a quiet camera (72 min idle, then
 * one 16 s session), 37 were motion that never stopped (89-102 sessions an
 * hour, det=0) and 41 were motion with candidates the detector scored below
 * the floor. The condition counted hours; it should count MOTION.
 *
 * ## What "blind" means now
 *
 * Since the last RAW OUTPUT of the detector (a detection, or a below-floor
 * candidate in `discarded`), ALL of:
 *
 *  1. the camera spent at least `minMotionMs` with a detection session open,
 *  2. across at least `minSessions` sessions (one long session is a person
 *     standing there, not a pattern),
 *  3. at least one frame was analysed, and the latest is fresh, and
 *  4. not one frame carried a detection or a discarded candidate.
 *
 * A below-floor candidate means the detector SAW something and the floor
 * filtered it: that is tuning, not blindness, and is carried in the payload
 * (`belowFloor`) rather than alerted. A camera that never opened a session
 * has no known motion source: its duty is `null` and nothing is classified
 * (D393). Recovery is a detection, unchanged.
 *
 * ## The other half: motion-noisy
 *
 * Over a rolling hour with zero detections, a camera whose sessions cover
 * {@link MOTION_NOISY_DUTY} of it, or open {@link MOTION_NOISY_SESSIONS_PER_HOUR}
 * times, is not blind either — its motion source is firing on nothing. That
 * is its own paired event (`motion-noisy` / `motion-calm`), never blind.
 *
 * Session edges arrive IN-PROCESS from the session registry: an in-memory
 * mirror, no read on the event path (D49), no second store. Pure, injected
 * clock, one transition per episode.
 */

/** How recently a frame must have arrived for the camera to count as "being
 *  analysed right now". Sized well above any normal inter-frame gap on a live
 *  attach, including a session that is between motion bursts. */
export const DETECTION_BLIND_FRAME_FRESHNESS_MS = 5 * 60_000

/** Motion the camera must have spent in sessions, with no raw output, to be blind. */
export const DETECTION_BLIND_MIN_MOTION_MS = 10 * 60_000

/** Sessions that motion must be spread over — one long session is a subject, not a pattern. */
export const DETECTION_BLIND_MIN_SESSIONS = 3

/** The window `motion-noisy` is judged over. */
export const MOTION_NOISY_WINDOW_MS = 60 * 60_000

/** Fraction of the window with a session open that makes motion constant. */
export const MOTION_NOISY_DUTY = 0.25

/** Sessions opened in the window that make motion constant. */
export const MOTION_NOISY_SESSIONS_PER_HOUR = 40

/** `motion-calm` needs the figures to fall to this share of the noisy bar — no flapping on the edge. */
export const MOTION_CALM_RATIO = 0.8

export interface DetectionBlindConfig {
  readonly minMotionMs: number
  readonly minSessions: number
  readonly frameFreshnessMs: number
  readonly noisyWindowMs: number
  readonly noisyDuty: number
  readonly noisySessionsPerHour: number
}

export const DEFAULT_DETECTION_BLIND_CONFIG: DetectionBlindConfig = {
  minMotionMs: DETECTION_BLIND_MIN_MOTION_MS,
  minSessions: DETECTION_BLIND_MIN_SESSIONS,
  frameFreshnessMs: DETECTION_BLIND_FRAME_FRESHNESS_MS,
  noisyWindowMs: MOTION_NOISY_WINDOW_MS,
  noisyDuty: MOTION_NOISY_DUTY,
  noisySessionsPerHour: MOTION_NOISY_SESSIONS_PER_HOUR,
}

/** What one analysed frame carried. */
export interface BlindFrameOutput {
  /** Detections that survived the floor. */
  readonly detections: number
  /** Candidates the detector produced and the floor discarded. */
  readonly discarded: number
}

/** One camera that just crossed into blind. */
export interface DetectionBlindEvent {
  readonly deviceId: number
  /** Wall time since its last detection (or since first seen), in ms — context only. */
  readonly blindForMs: number
  /** The motion bar that was crossed, in ms. */
  readonly thresholdMs: number
  /** Session-open time since the detector last produced anything. */
  readonly motionMs: number
  /** Sessions opened in that time. */
  readonly sessions: number
  /** Below-floor frames since the last detection (0 at the moment of an alert, by the gate; carried for the payload). */
  readonly belowFloor: number
}

/** A camera whose motion source fires constantly on nothing, or stopped doing so. */
export interface MotionNoiseEvent {
  readonly deviceId: number
  readonly phase: 'noisy' | 'calm'
  readonly windowMs: number
  /** Share of the window with a session open, 0..1. */
  readonly duty: number
  /** Sessions opened in the window. */
  readonly sessions: number
}

interface SessionSpan {
  readonly start: number
  /** `null` while the session is still open. */
  readonly end: number | null
}

interface DeviceState {
  readonly trackedSince: number
  readonly lastFrameAt: number | null
  readonly lastDetectionAt: number | null
  /** True once the blind event fired, so it fires once per episode. */
  readonly reported: boolean
  /** True once `motion-noisy` fired and `motion-calm` has not. */
  readonly noisy: boolean
  /** Whether a session edge was EVER heard — the motion source is known. */
  readonly motionKnown: boolean
  /** Session-open ms of CLOSED sessions since the last raw output. */
  readonly closedMs: number
  /** Start of the open session's counted stretch, or null. */
  readonly openSince: number | null
  readonly sessions: number
  readonly frames: number
  readonly belowFloor: number
  /** Spans inside the noisy window, oldest first. */
  readonly spans: readonly SessionSpan[]
}

export class DetectionBlindMonitor {
  private readonly config: DetectionBlindConfig
  private readonly state = new Map<number, DeviceState>()

  constructor(config: DetectionBlindConfig = DEFAULT_DETECTION_BLIND_CONFIG) {
    this.config = config
  }

  private fresh(now: number): DeviceState {
    return {
      trackedSince: now,
      lastFrameAt: null,
      lastDetectionAt: null,
      reported: false,
      noisy: false,
      motionKnown: false,
      closedMs: 0,
      openSince: null,
      sessions: 0,
      frames: 0,
      belowFloor: 0,
      spans: [],
    }
  }

  /** A detection session opened. A duplicate edge on an open session is ignored. */
  noteSessionOpen(deviceId: number, now: number): void {
    const s = this.state.get(deviceId) ?? this.fresh(now)
    const last = s.spans[s.spans.length - 1]
    if (last !== undefined && last.end === null) return
    this.state.set(deviceId, {
      ...s,
      motionKnown: true,
      openSince: now,
      sessions: s.sessions + 1,
      spans: [...s.spans, { start: now, end: null }],
    })
  }

  /** A detection session closed. A close with no open session is ignored. */
  noteSessionClose(deviceId: number, now: number): void {
    const s = this.state.get(deviceId)
    if (s === undefined) return
    const last = s.spans[s.spans.length - 1]
    if (last === undefined || last.end !== null) return
    this.state.set(deviceId, {
      ...s,
      closedMs: s.closedMs + (s.openSince !== null ? Math.max(0, now - s.openSince) : 0),
      openSince: null,
      spans: [...s.spans.slice(0, -1), { start: last.start, end: now }],
    })
  }

  /**
   * One inference frame arrived for a device. An empty frame still proves the
   * pipeline is alive; a frame with only `discarded` proves the detector SAW
   * something — raw output, so not blind, but not a detection either.
   */
  noteFrame(deviceId: number, output: BlindFrameOutput, now: number): void {
    const s = this.state.get(deviceId) ?? this.fresh(now)
    if (output.detections > 0) {
      this.state.set(deviceId, {
        ...s,
        ...this.restartBlindWindow(s, now),
        lastFrameAt: now,
        lastDetectionAt: now,
        reported: false,
        belowFloor: 0,
      })
      return
    }
    if (output.discarded > 0) {
      this.state.set(deviceId, {
        ...s,
        ...this.restartBlindWindow(s, now),
        lastFrameAt: now,
        belowFloor: s.belowFloor + 1,
      })
      return
    }
    this.state.set(deviceId, { ...s, lastFrameAt: now, frames: s.frames + 1 })
  }

  /** Counters since the last raw output restart; an open session keeps counting from now. */
  private restartBlindWindow(
    s: DeviceState,
    now: number,
  ): Pick<DeviceState, 'closedMs' | 'openSince' | 'sessions' | 'frames'> {
    const open = s.openSince !== null
    return { closedMs: 0, openSince: open ? now : null, sessions: open ? 1 : 0, frames: 0 }
  }

  /**
   * Devices that have JUST crossed into blind. Call from an existing periodic
   * sweep; it allocates nothing on the healthy path.
   */
  sweep(now: number): readonly DetectionBlindEvent[] {
    const out: DetectionBlindEvent[] = []
    for (const [deviceId, s] of this.state) {
      if (s.reported || !s.motionKnown) continue
      // Not being analysed right now → not blind, just quiet.
      if (s.lastFrameAt === null || now - s.lastFrameAt > this.config.frameFreshnessMs) continue
      if (s.frames === 0) continue
      const motionMs = s.closedMs + (s.openSince !== null ? now - s.openSince : 0)
      if (motionMs < this.config.minMotionMs) continue
      if (s.sessions < this.config.minSessions) continue
      this.state.set(deviceId, { ...s, reported: true })
      out.push({
        deviceId,
        blindForMs: now - (s.lastDetectionAt ?? s.trackedSince),
        thresholdMs: this.config.minMotionMs,
        motionMs,
        sessions: s.sessions,
        belowFloor: s.belowFloor,
      })
    }
    return out
  }

  /**
   * `motion-noisy` / `motion-calm` transitions. Judged over the rolling window,
   * only on a camera whose motion source is known and that has been watched for
   * the whole window with no detection in it.
   */
  sweepMotion(now: number): readonly MotionNoiseEvent[] {
    const out: MotionNoiseEvent[] = []
    const window = this.config.noisyWindowMs
    const from = now - window
    for (const [deviceId, s] of this.state) {
      if (!s.motionKnown) continue
      const spans = s.spans.filter((span) => (span.end ?? now) > from)
      let motionMs = 0
      let opened = 0
      for (const span of spans) {
        motionMs += Math.min(span.end ?? now, now) - Math.max(span.start, from)
        if (span.start >= from) opened += 1
      }
      const duty = motionMs / window
      const lastDetectionAt = s.lastDetectionAt
      const quietForWindow = now - (lastDetectionAt ?? s.trackedSince) >= window
      const noisyNow =
        quietForWindow &&
        (duty >= this.config.noisyDuty || opened >= this.config.noisySessionsPerHour)
      let noisy = s.noisy
      if (!noisy && noisyNow) {
        noisy = true
        out.push({ deviceId, phase: 'noisy', windowMs: window, duty, sessions: opened })
      } else if (noisy) {
        const detected = lastDetectionAt !== null && lastDetectionAt > from
        const fellBack =
          duty < this.config.noisyDuty * MOTION_CALM_RATIO &&
          opened < this.config.noisySessionsPerHour * MOTION_CALM_RATIO
        if (detected || fellBack) {
          noisy = false
          out.push({ deviceId, phase: 'calm', windowMs: window, duty, sessions: opened })
        }
      }
      if (noisy !== s.noisy || spans.length !== s.spans.length) {
        this.state.set(deviceId, { ...s, noisy, spans })
      }
    }
    return out
  }

  /** Drop a device (detach / unbind), so a re-attach starts a fresh clock. */
  forget(deviceId: number): void {
    this.state.delete(deviceId)
  }

  reset(): void {
    this.state.clear()
  }
}
