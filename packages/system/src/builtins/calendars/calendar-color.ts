/**
 * Deterministic system colours for calendar ids — same id → same hue for
 * every operator until they override via per-user preferences.
 */

import type { CalendarColor } from '@camstack/types'

/** Fixed palette — high-contrast hues that read on light and dark chrome. */
export const CALENDAR_COLOR_PALETTE: readonly CalendarColor[] = [
  '#2563EB', // blue
  '#DC2626', // red
  '#16A34A', // green
  '#D97706', // amber
  '#7C3AED', // violet
  '#0891B2', // cyan
  '#DB2777', // pink
  '#65A30D', // lime
  '#EA580C', // orange
  '#4F46E5', // indigo
  '#0D9488', // teal
  '#BE123C', // rose
]

/** Stable FNV-1a-ish hash → palette index. */
export function defaultCalendarColor(calendarId: string): CalendarColor {
  let hash = 2166136261
  for (let i = 0; i < calendarId.length; i += 1) {
    hash ^= calendarId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const index = Math.abs(hash) % CALENDAR_COLOR_PALETTE.length
  return CALENDAR_COLOR_PALETTE[index]!
}
