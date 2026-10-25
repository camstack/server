import type { BacklightMode, DayNightMode, ExposureMode, ImageRotate } from '@camstack/types'

/**
 * Pure value maps between the Dahua CGI table vocabulary and the
 * vendor-neutral cap enums. Every token and bound in this file was
 * verified against the live IP4M-1041B (firmware 2.800.1ENN001.0.R,
 * build 2024-10-29) on 2026-09-04 — see the matching spec
 * (`__tests__/dahua-mappings.spec.ts`) for the write/read-back and
 * functional evidence per value. Nothing here is copied from a Dahua
 * PDF without a live round-trip.
 */

// ── Day/night (VideoInDayNight[0][0]) ──────────────────────────────

/** `Sensitivity` native max — the firmware accepts 0..7 (8 → HTTP 400).
 *  The old assumed max of 3 compressed the top half of the normalized
 *  slider into a single native step. */
export const DAY_NIGHT_SENSITIVITY_NATIVE_MAX = 7

/** `Delay` writable window in seconds — 1 and 11 are both rejected. */
export const DAY_NIGHT_DELAY_MIN_SEC = 2
export const DAY_NIGHT_DELAY_MAX_SEC = 10

const DAY_NIGHT_NATIVE_TO_CAP: Readonly<Record<string, DayNightMode>> = {
  // `Brightness` = "switch on measured luminance" — the vendor UI's Auto.
  Brightness: 'auto',
  // `Color` = always color = force day.
  Color: 'day',
  // `BlackWhite` = always B/W = force night (snapshot-verified grayscale).
  BlackWhite: 'night',
}

const DAY_NIGHT_CAP_TO_NATIVE: Readonly<Record<DayNightMode, string | undefined>> = {
  auto: 'Brightness',
  day: 'Color',
  night: 'BlackWhite',
  // No verified schedule token on this firmware — `Photoresistor` (the
  // doc-sheet guess) is rejected with HTTP 400, and the time-section
  // profile machinery (`VideoInMode`) is a different mechanism entirely.
  schedule: undefined,
}

/** Native `Mode` token → cap mode. Unknown tokens read as `auto` — the
 *  status must never throw on firmware drift, and `auto` is the only
 *  mode every Dahua ships in. */
export function amcrestDayNightModeToCap(raw: string | undefined): DayNightMode {
  if (raw === undefined) return 'auto'
  return DAY_NIGHT_NATIVE_TO_CAP[raw] ?? 'auto'
}

/** Cap mode → native token, or `undefined` when no verified native
 *  exists (the caller warns and skips rather than guessing). */
export function capDayNightModeToAmcrest(mode: DayNightMode): string | undefined {
  return DAY_NIGHT_CAP_TO_NATIVE[mode]
}

/** Native 0..7 → normalized 0..100. */
export function dayNightSensitivityToPercent(native: number): number {
  return Math.round((native / DAY_NIGHT_SENSITIVITY_NATIVE_MAX) * 100)
}

/** Normalized 0..100 → native 0..7, clamped to what the firmware accepts. */
export function percentToDayNightSensitivity(percent: number): number {
  const native = Math.round((percent / 100) * DAY_NIGHT_SENSITIVITY_NATIVE_MAX)
  return Math.max(0, Math.min(DAY_NIGHT_SENSITIVITY_NATIVE_MAX, native))
}

/** Clamp a requested switch delay into the firmware's 2..10 s window —
 *  an out-of-window write is rejected wholesale (HTTP 400), which would
 *  silently drop the ROUND TRIP, not just this field. */
export function clampDayNightDelaySec(sec: number): number {
  return Math.max(DAY_NIGHT_DELAY_MIN_SEC, Math.min(DAY_NIGHT_DELAY_MAX_SEC, Math.round(sec)))
}

// ── Rotation (VideoImageControl[0].Rotate90) ───────────────────────

/** Native `Rotate90` int → cap degrees-clockwise. 1 was verified live
 *  (snapshot flipped to 1440×2560); 2 is the documented counterpart
 *  (90° ccw = 270° cw). Anything else (the field stores e.g. `3`
 *  verbatim) has no defined meaning → `undefined`. */
export function amcrestRotateToCap(raw: number | undefined): ImageRotate | undefined {
  if (raw === 0) return '0'
  if (raw === 1) return '90'
  if (raw === 2) return '270'
  return undefined
}

/** Cap rotation → native `Rotate90` int. `'180'` has no Dahua
 *  equivalent on this family (the vendor UI composes mirror+flip) —
 *  `undefined` tells the caller to skip the write. */
export function capRotateToAmcrest(rotate: ImageRotate): number | undefined {
  if (rotate === '0') return 0
  if (rotate === '90') return 1
  if (rotate === '270') return 2
  return undefined
}

// ── Backlight compensation (VideoInBacklight[0][0].Mode) ───────────

const BACKLIGHT_NATIVE_TO_CAP: Readonly<Record<string, BacklightMode>> = {
  Off: 'off',
  Backlight: 'blc',
  WideDynamic: 'wdr',
  GlareInhibition: 'hlc',
}

const BACKLIGHT_CAP_TO_NATIVE: Readonly<Record<BacklightMode, string>> = {
  off: 'Off',
  blc: 'Backlight',
  wdr: 'WideDynamic',
  hlc: 'GlareInhibition',
}

/** Native backlight token → cap mode. The field is NOT validated by the
 *  firmware (a bogus token is stored verbatim), so an unknown read maps
 *  to `undefined` — reported as "no answer", never guessed. */
export function amcrestBacklightToCap(raw: string | undefined): BacklightMode | undefined {
  if (raw === undefined) return undefined
  return BACKLIGHT_NATIVE_TO_CAP[raw]
}

export function capBacklightToAmcrest(mode: BacklightMode): string {
  return BACKLIGHT_CAP_TO_NATIVE[mode]
}

// ── Exposure mode (VideoInExposure[0][0].Mode) ─────────────────────

/** Native exposure mode int → cap mode. The field IS validated by the
 *  firmware (99 → HTTP 400). 0=Auto, 4=Manual (verified functionally:
 *  Mode=4 + Value1/2=1 ms produced a near-black frame). The natives in
 *  between are vendor presets (low-noise / low-motion-blur) the cap's
 *  two-value enum cannot express → `undefined`, so the UI shows the
 *  select unset instead of lying `auto`. */
export function amcrestExposureModeToCap(raw: number | undefined): ExposureMode | undefined {
  if (raw === 0) return 'auto'
  if (raw === 4) return 'manual'
  return undefined
}

export function capExposureModeToAmcrest(mode: ExposureMode): number {
  return mode === 'manual' ? 4 : 0
}
