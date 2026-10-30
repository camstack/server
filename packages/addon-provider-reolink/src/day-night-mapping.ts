import type { DayNightMode } from '@camstack/types'
import { userError } from '@camstack/types'

/**
 * Maps between the vendor-neutral `day-night` cap's `DayNightMode` and
 * Reolink's raw `VideoInput.dayNight` / `InputAdvanceCfg.DayNight.mode`
 * string (Baichuan cmdId 25/26 via `setIsp`/`getVideoInput`). Firmwares
 * report/accept camel-cased values such as `auto`, `color`,
 * `blackAndWhite` — case varies by model; the lib's `normalizeDayNightMode`
 * lower-cases the first letter before push, so the mapping here works off
 * a case-insensitive compare.
 *
 * There is no on-camera "schedule" mode in the Baichuan protocol — the
 * `day-night` cap's `getOptions.modes` never advertises `'schedule'` for
 * a Reolink device.
 */

const NIGHT_TOKENS = new Set(['blackandwhite', 'black&white', 'bw', 'night', 'blackwhite'])
const DAY_TOKENS = new Set(['color', 'colour', 'day'])

/**
 * Map the camera's raw `dayNight` string to the cap's normalized mode.
 * Falls back to `'auto'` for an unrecognized or missing value — every
 * Reolink camera defaults to auto IR-cut switching out of the box.
 */
export function reolinkDayNightModeToCap(raw: string | undefined): DayNightMode {
  if (typeof raw !== 'string' || raw.length === 0) return 'auto'
  const normalized = raw.toLowerCase()
  if (normalized === 'auto') return 'auto'
  if (NIGHT_TOKENS.has(normalized)) return 'night'
  if (DAY_TOKENS.has(normalized)) return 'day'
  return 'auto'
}

/**
 * Map the cap's normalized mode to the raw value Reolink's `setIsp`
 * expects. `'schedule'` has no Reolink equivalent — `getOptions.modes`
 * never advertises it, so a well-behaved caller never passes it here;
 * guard defensively in case one does anyway.
 */
export function capDayNightModeToReolink(mode: DayNightMode): string {
  switch (mode) {
    case 'auto':
      return 'auto'
    case 'day':
      return 'color'
    case 'night':
      return 'blackAndWhite'
    case 'schedule':
      throw userError(
        'reolink.day-night-schedule-unsupported',
        undefined,
        'Reolink cameras do not support a scheduled day/night mode',
      )
  }
}
