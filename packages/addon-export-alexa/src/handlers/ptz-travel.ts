/**
 * One Alexa PTZ voice command = ~1 s of head travel, built ONLY from the PTZ
 * cap's `ptz.move`.
 *
 * `move` is a self-terminating burst: the driver runs it for the pulse it
 * calibrated and stops the head itself, and reports that pulse as
 * `getOptions().moveImpulseMs` (ptz.cap.ts) — 200 reolink, 350 amcrest,
 * 500 hikvision, 1000 onvif. One pulse is too short a nudge for a voice
 * command, so the travel issues `round(TARGET_TRAVEL_MS / moveImpulseMs)` of
 * them back to back. There is no `continuousMove` / timer / `stop` here:
 * ONVIF does not implement `continuousMove`, and `move` needs no stop.
 *
 * Drivers differ in WHEN `move` resolves: hikvision awaits its own pulse,
 * reolink / amcrest / onvif return as soon as the burst has started. Each pulse
 * is awaited, then the remainder of its impulse is waited out, so both kinds
 * yield consecutive pulses rather than overlapping ones (which a driver would
 * collapse into one). An unknown impulse is a single `move`.
 */

/** How far a voice command moves the head, in driver-pulse milliseconds. */
export const TARGET_TRAVEL_MS = 1_000

export interface PtzTravelMove {
  readonly pan?: number
  readonly tilt?: number
}

/** The two `ptz` cap methods a travel uses — a structural slice of `AddonApi['ptz']`. */
export interface PtzTravelApi {
  readonly getOptions: {
    query(input: { deviceId: number }): Promise<{ readonly moveImpulseMs: number | null }>
  }
  readonly move: {
    mutate(input: { deviceId: number; pan?: number; tilt?: number }): Promise<void>
  }
}

export interface PtzTravelClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface PtzTravelResult {
  /** Pulses the travel planned. */
  readonly pulses: number
  /** Pulses that were issued successfully. */
  readonly issued: number
  /** Set when a pulse after the first failed; the travel stopped there. */
  readonly error?: Error
}

const realClock: PtzTravelClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** `max(1, round(TARGET_TRAVEL_MS / moveImpulseMs))`; unknown impulse → 1. */
export function ptzTravelPulses(moveImpulseMs: number | null): number {
  if (moveImpulseMs === null || !(moveImpulseMs > 0)) return 1
  return Math.max(1, Math.round(TARGET_TRAVEL_MS / moveImpulseMs))
}

/** `getOptions().moveImpulseMs`, or `null` when unreported or unreadable. */
async function readImpulse(ptz: PtzTravelApi, deviceId: number): Promise<number | null> {
  try {
    const ms = (await ptz.getOptions.query({ deviceId })).moveImpulseMs
    return typeof ms === 'number' && ms > 0 ? ms : null
  } catch {
    // Unreadable options degrade to one `move` — the head still moves.
    return null
  }
}

/**
 * Runs the travel. REJECTS when the first `move` fails (nothing moved, the
 * caller answers with an error); a later failure stops the travel and is
 * returned in `error`, since the head has already moved.
 */
export async function runPtzTravel(
  ptz: PtzTravelApi,
  deviceId: number,
  direction: PtzTravelMove,
  clock: PtzTravelClock = realClock,
): Promise<PtzTravelResult> {
  const impulse = await readImpulse(ptz, deviceId)
  const pulses = ptzTravelPulses(impulse)
  for (let i = 0; i < pulses; i++) {
    const startedAt = clock.now()
    try {
      await ptz.move.mutate({ deviceId, ...direction })
    } catch (err: unknown) {
      if (i === 0) throw err
      return { pulses, issued: i, error: err instanceof Error ? err : new Error(String(err)) }
    }
    const isLast = i === pulses - 1
    if (!isLast && impulse !== null) {
      const remaining = impulse - (clock.now() - startedAt)
      if (remaining > 0) await clock.sleep(remaining)
    }
  }
  return { pulses, issued: pulses }
}
