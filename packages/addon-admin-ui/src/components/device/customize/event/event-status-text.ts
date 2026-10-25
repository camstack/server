/**
 * Operator-facing motion and doorbell status lines (no catalog jargon).
 * Pure helpers — cards attach i18n keys from the returned kind.
 */
import { MIN_PLAUSIBLE_TIMESTAMP_MS } from '../../hero/format'

export type MotionNowKind = 'pending' | 'unknown' | 'quiet' | 'active'

export interface MotionNowStatus {
  readonly kind: MotionNowKind
  /** Whole seconds since motion started; only when kind is `active`. */
  readonly seconds: number | null
}

export function motionNowStatus(
  detected: 'pending' | 'unknown' | boolean | null | undefined,
  lastDetectedAt: number | null | undefined,
  nowMs: number,
): MotionNowStatus {
  if (detected === 'pending') return { kind: 'pending', seconds: null }
  if (detected === 'unknown' || detected === null || detected === undefined) {
    return { kind: 'unknown', seconds: null }
  }
  if (!detected) return { kind: 'quiet', seconds: null }
  const seconds = motionActiveSeconds(lastDetectedAt, nowMs)
  if (seconds === null) return { kind: 'unknown', seconds: null }
  return { kind: 'active', seconds }
}

export function motionActiveSeconds(
  lastDetectedAt: number | null | undefined,
  nowMs: number,
): number | null {
  if (
    lastDetectedAt === null ||
    lastDetectedAt === undefined ||
    !Number.isFinite(lastDetectedAt) ||
    lastDetectedAt < MIN_PLAUSIBLE_TIMESTAMP_MS
  ) {
    return null
  }
  const delta = Math.floor((nowMs - lastDetectedAt) / 1000)
  return delta < 0 ? 0 : delta
}

export type DoorbellRingKind = 'pending' | 'unknown' | 'none' | 'ring'

export interface DoorbellRingStatus {
  readonly kind: DoorbellRingKind
  readonly lastPressedAt: number | null
  readonly pressCount: number | null
}

export function doorbellRingStatus(
  lastPressedAt: 'pending' | 'unknown' | number | null | undefined,
  pressCount: number | null | undefined,
): DoorbellRingStatus {
  if (lastPressedAt === 'pending') {
    return { kind: 'pending', lastPressedAt: null, pressCount: null }
  }
  if (lastPressedAt === 'unknown') {
    return { kind: 'unknown', lastPressedAt: null, pressCount: null }
  }
  const at =
    typeof lastPressedAt === 'number' &&
    Number.isFinite(lastPressedAt) &&
    lastPressedAt >= MIN_PLAUSIBLE_TIMESTAMP_MS
      ? lastPressedAt
      : null
  const count =
    typeof pressCount === 'number' && Number.isFinite(pressCount) && pressCount >= 0
      ? pressCount
      : null
  if (at === null) return { kind: 'none', lastPressedAt: null, pressCount: count }
  return { kind: 'ring', lastPressedAt: at, pressCount: count }
}
