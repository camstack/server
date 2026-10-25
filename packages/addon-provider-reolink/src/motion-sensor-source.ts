import type { ReolinkEvent, ReolinkSimpleEvent } from '@apocaliss92/nodelink-js'

/**
 * Which sensor fired a Reolink motion push: the image-based motion detector
 * (`md`) or the passive-infrared sensor (`pir`).
 *
 * nodelink-js decodes it — `ReolinkMotionNotification.motion.source`, from the
 * alarm status (`MD` / `PIR`) of cmd 33 — but `mapToSimpleEvent` builds the
 * `ReolinkSimpleEvent` the provider subscribes to WITHOUT it (0.12.0 and
 * 0.12.4 alike). So the provider reads it off the RAW client event, which the
 * client emits immediately before the API maps it, and hands it to the simple
 * event of the same channel.
 */
export type ReolinkMotionSensor = 'md' | 'pir' | 'unknown'

/**
 * A raw notification older than this cannot belong to the simple event being
 * handled: the API maps and dispatches in the same `event` emit.
 */
export const MOTION_SENSOR_MATCH_WINDOW_MS = 2_000

export interface MotionSensorTracker {
  /** Record a raw client event; only motion notifications carry a sensor. */
  observe(event: ReolinkEvent): void
  /**
   * The sensor of the motion push on `channel`, consumed once. `null` when the
   * transport did not say (email / webhook pushes, an AI push, a stale entry).
   */
  take(channel: number): ReolinkMotionSensor | null
}

export function createMotionSensorTracker(now: () => number = Date.now): MotionSensorTracker {
  const latest = new Map<number, { readonly sensor: ReolinkMotionSensor; readonly at: number }>()
  return {
    observe(event) {
      if (event.type !== 'motion') return
      const sensor = event.motion.source
      if (sensor === undefined) return
      latest.set(event.channel, { sensor, at: now() })
    },
    take(channel) {
      const entry = latest.get(channel)
      if (!entry) return null
      latest.delete(channel)
      return now() - entry.at <= MOTION_SENSOR_MATCH_WINDOW_MS ? entry.sensor : null
    },
  }
}

const isMotionSensor = (value: unknown): value is ReolinkMotionSensor =>
  value === 'md' || value === 'pir' || value === 'unknown'

/**
 * The sensor a simple event states itself, for a library version that forwards
 * `motion.source` on the simple event; `null` for the versions that do not.
 */
export function motionSensorOnSimpleEvent(event: ReolinkSimpleEvent): ReolinkMotionSensor | null {
  if (!('motion' in event)) return null
  const motion: unknown = event.motion
  if (typeof motion !== 'object' || motion === null || !('source' in motion)) return null
  return isMotionSensor(motion.source) ? motion.source : null
}
