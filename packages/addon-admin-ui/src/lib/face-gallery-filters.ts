/**
 * Pure client-side filtering + formatting helpers for the face gallery.
 *
 * The `face-gallery.listRecentFaces` cap only accepts `limit` + a coarse
 * assigned/recognized `filter`. Date-range and per-camera narrowing are done
 * HERE, in the component, over the already-fetched window — no cap parameters
 * added (keeps this an addon-only change that ships via `camstack deploy`).
 *
 * Everything in this module is pure + framework-free so it is unit-testable.
 */

/** Minimal shape needed to date-filter / format a face. */
export interface TimestampedFace {
  readonly timestamp: number
}

/** Minimal shape needed to camera-filter a face. */
export interface CameraScopedFace {
  readonly deviceId: number
}

/** Inclusive epoch-ms window. `null` on either side = open-ended. */
export interface DateRange {
  readonly fromMs: number | null
  readonly toMs: number | null
}

export const EMPTY_DATE_RANGE: DateRange = { fromMs: null, toMs: null }

export type DateRangePreset = '24h' | '7d' | '30d' | 'all'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Resolve a relative preset into an absolute window anchored at `nowMs`. */
export function presetToRange(preset: DateRangePreset, nowMs: number): DateRange {
  switch (preset) {
    case '24h':
      return { fromMs: nowMs - DAY_MS, toMs: null }
    case '7d':
      return { fromMs: nowMs - 7 * DAY_MS, toMs: null }
    case '30d':
      return { fromMs: nowMs - 30 * DAY_MS, toMs: null }
    case 'all':
      return EMPTY_DATE_RANGE
  }
}

/** True when the range constrains at least one bound. */
export function isRangeActive(range: DateRange): boolean {
  return range.fromMs !== null || range.toMs !== null
}

/** Faces whose timestamp falls inside `range` (inclusive), input order kept. */
export function filterFacesByDateRange<T extends TimestampedFace>(
  faces: readonly T[],
  range: DateRange,
): T[] {
  if (!isRangeActive(range)) return [...faces]
  return faces.filter((f) => {
    if (range.fromMs !== null && f.timestamp < range.fromMs) return false
    if (range.toMs !== null && f.timestamp > range.toMs) return false
    return true
  })
}

/** Faces whose deviceId is in `deviceIds`. An empty set means "no filter". */
export function filterFacesByCameras<T extends CameraScopedFace>(
  faces: readonly T[],
  deviceIds: ReadonlySet<number>,
): T[] {
  if (deviceIds.size === 0) return [...faces]
  return faces.filter((f) => deviceIds.has(f.deviceId))
}

/** Distinct deviceIds present in the faces, in first-seen order. */
export function distinctDeviceIds(faces: readonly CameraScopedFace[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const f of faces) {
    if (!seen.has(f.deviceId)) {
      seen.add(f.deviceId)
      out.push(f.deviceId)
    }
  }
  return out
}

/** `<input type="date">` value → start-of-day epoch ms (local). */
export function dateInputToStartMs(value: string): number | null {
  if (!value) return null
  const ms = Date.parse(`${value}T00:00:00`)
  return Number.isNaN(ms) ? null : ms
}

/** `<input type="date">` value → end-of-day epoch ms (local, inclusive). */
export function dateInputToEndMs(value: string): number | null {
  if (!value) return null
  const ms = Date.parse(`${value}T23:59:59.999`)
  return Number.isNaN(ms) ? null : ms
}

/** Epoch ms → `yyyy-mm-dd` for a native date input value. */
export function msToDateInput(ms: number | null): string {
  if (ms === null) return ''
  const d = new Date(ms)
  const y = String(d.getFullYear())
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

import i18n from '../i18n/index'

/**
 * Compact card label: relative under a week ("just now", "5m ago", "3h ago",
 * "2d ago"), short absolute date otherwise ("Apr 3"). Returns "—" for bogus
 * timestamps.
 */
export function formatFaceTimestamp(ms: number, nowMs: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const delta = nowMs - ms
  if (delta < 60_000) return i18n.t('helpers.relativeTime.justNow')
  if (delta < HOUR_MS)
    return i18n.t('helpers.relativeTime.minutesAgo', { count: Math.floor(delta / 60_000) })
  if (delta < DAY_MS)
    return i18n.t('helpers.relativeTime.hoursAgo', { count: Math.floor(delta / HOUR_MS) })
  if (delta < 7 * DAY_MS)
    return i18n.t('helpers.relativeTime.daysAgo', { count: Math.floor(delta / DAY_MS) })
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Clock-only timestamp for per-media rows ("14:32:07"). */
export function formatClockTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Full absolute timestamp for the detail panel ("Apr 3, 2026, 14:32:07"). */
export function formatFaceTimestampFull(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
