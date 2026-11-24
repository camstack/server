import type { MotionTriggerStatus } from '@camstack/types'

/**
 * What a `motion-trigger` slice says. `unknown` is the cold-start seed a provider
 * writes before the camera was ever read (`enabled: false`, `lastChangedAt: 0`):
 * the `false` there is a placeholder, not an answer, so no surface may draw it as off.
 */
export type MotionTriggerReading = 'on' | 'off' | 'unknown'

export function readMotionTrigger(
  slice: Pick<MotionTriggerStatus, 'enabled' | 'lastChangedAt'>,
): MotionTriggerReading {
  if (slice.enabled) return 'on'
  return slice.lastChangedAt === 0 ? 'unknown' : 'off'
}
