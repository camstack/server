import type { UiTextFn } from '../../../contexts/ui-text'
import { MIN_PLAUSIBLE_TIMESTAMP_MS } from '../../../lib/format-last-seen'
import { coarseDuration } from './coarse-duration'

/**
 * The corner's "since": how long ago `changedAt` was, or nothing when that
 * stamp is not a real instant (seeded `1` / `0`, or still in the future).
 */
export function sinceText(
  changedAt: number | null | undefined,
  now: number,
  t: UiTextFn,
): string | undefined {
  if (typeof changedAt !== 'number' || !Number.isFinite(changedAt)) return undefined
  if (changedAt < MIN_PLAUSIBLE_TIMESTAMP_MS || changedAt > now) return undefined
  return coarseDuration(now - changedAt, t)
}
