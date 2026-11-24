import type { MotionTriggerRuntimeState } from '@camstack/types'

/**
 * What a `motion-trigger` slice says. `unknown` is the cold-start seed a provider
 * writes before the camera was ever read (`enabled: false`, `lastChangedAt: 0`,
 * `lastFetchedAt: 0`): the `false` there is a placeholder, not an answer, so no
 * surface may draw it as off. A firmware read stamps `lastFetchedAt` even when the
 * value did not change (and so `lastChangedAt` stays 0), which makes it a real off.
 */
export type MotionTriggerReading = 'on' | 'off' | 'unknown'

export function readMotionTrigger(
  slice: Pick<MotionTriggerRuntimeState, 'enabled' | 'lastChangedAt'> &
    Partial<Pick<MotionTriggerRuntimeState, 'lastFetchedAt'>>,
): MotionTriggerReading {
  if (slice.enabled) return 'on'
  const neverRead = (slice.lastFetchedAt ?? 0) === 0 && slice.lastChangedAt === 0
  return neverRead ? 'unknown' : 'off'
}
