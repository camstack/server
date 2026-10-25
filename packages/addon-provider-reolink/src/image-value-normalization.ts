/**
 * Generic native-range <-> normalized-0-100 conversion shared by the
 * `day-night` (sensitivity) and `image-settings` (brightness / contrast /
 * saturation / sharpness) native caps. Both caps' vendor-neutral contract
 * normalizes every slider to an integer 0-100 scale; each provider maps
 * its own native range (Reolink's image sliders are 0..255, the day/night
 * threshold range is camera-probed) to/from that scale here.
 */

/** Map a native value inside `[min, max]` to the normalized 0-100 scale. */
export function normalizeToPercent(value: number, min: number, max: number): number {
  if (max <= min) return 0
  const percent = ((value - min) / (max - min)) * 100
  return Math.max(0, Math.min(100, Math.round(percent)))
}

/** Map a normalized 0-100 value back to the native `[min, max]` range. */
export function denormalizeFromPercent(percent: number, min: number, max: number): number {
  const clamped = Math.max(0, Math.min(100, percent))
  return Math.round(min + (clamped / 100) * (max - min))
}
