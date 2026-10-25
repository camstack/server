/**
 * The time windows a history view offers, and the "previous period" a
 * comparison reads. Pure: the caller supplies `now`.
 */

export type HistoryWindowId = '24h' | '7d' | '30d' | '1y' | 'custom'

export const HISTORY_WINDOW_IDS: readonly ['24h', '7d', '30d', '1y', 'custom'] = [
  '24h',
  '7d',
  '30d',
  '1y',
  'custom',
]

const H = 3_600_000
const D = 24 * H

export const HISTORY_WINDOW_MS: Readonly<Record<Exclude<HistoryWindowId, 'custom'>, number>> = {
  '24h': D,
  '7d': 7 * D,
  '30d': 30 * D,
  '1y': 365 * D,
}

export interface HistoryWindow {
  readonly from: number
  readonly to: number
}

export interface CustomWindow {
  readonly from: number
  readonly to: number
}

export function isHistoryWindowId(v: string | null | undefined): v is HistoryWindowId {
  return v !== null && v !== undefined && (HISTORY_WINDOW_IDS as readonly string[]).includes(v)
}

/**
 * The window a preset means at `now`. `custom` without a valid range (from
 * before to) falls back to the last 24 hours rather than an empty window.
 */
export function resolveHistoryWindow(
  id: HistoryWindowId,
  now: number,
  custom?: CustomWindow | null,
): HistoryWindow {
  if (id === 'custom') {
    if (custom && custom.to > custom.from) return { from: custom.from, to: custom.to }
    return { from: now - HISTORY_WINDOW_MS['24h'], to: now }
  }
  return { from: now - HISTORY_WINDOW_MS[id], to: now }
}

/** The period of the same length just before `w`, and the shift that lays it over `w`. */
export function previousWindow(w: HistoryWindow): {
  readonly window: HistoryWindow
  readonly shiftMs: number
} {
  const span = w.to - w.from
  return { window: { from: w.from - span, to: w.to - span }, shiftMs: span }
}

/** Encode a custom range for the URL: `<fromMs>-<toMs>`. */
export function encodeCustomWindow(w: CustomWindow): string {
  return `${String(Math.round(w.from))}-${String(Math.round(w.to))}`
}

export function decodeCustomWindow(raw: string | null | undefined): CustomWindow | null {
  if (!raw) return null
  const m = /^(\d+)-(\d+)$/.exec(raw)
  if (!m) return null
  const from = Number(m[1])
  const to = Number(m[2])
  return to > from ? { from, to } : null
}

/** Milliseconds a rollup bucket of a resolution covers (`1d` is nominal across DST). */
export const RESOLUTION_BUCKET_MS: Readonly<Record<'5m' | '1h' | '1d', number>> = {
  '5m': 5 * 60_000,
  '1h': H,
  '1d': D,
}
