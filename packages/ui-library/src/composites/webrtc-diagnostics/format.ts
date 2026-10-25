/**
 * Rendering helpers for the WebRTC diagnostics: an unmeasured value is the
 * word "unknown", never a dash that reads as zero and never a 0 (D393).
 */

export const UNKNOWN_TEXT = 'unknown'

export function formatMaybe<T>(value: T | null, render: (v: T) => string): string {
  return value === null ? UNKNOWN_TEXT : render(value)
}

export const fmtMs = (v: number | null): string =>
  // i18n-ignore: unit symbol
  formatMaybe(v, (n) => `${String(Math.round(n))} ms`)

export const fmtCount = (v: number | null): string => formatMaybe(v, (n) => n.toLocaleString())

export const fmtBytes = (v: number | null): string =>
  formatMaybe(v, (n) => {
    // i18n-ignore-start: unit symbols
    if (n < 1024) return `${String(n)} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
    return `${(n / (1024 * 1024)).toFixed(2)} MiB`
    // i18n-ignore-end
  })

export const fmtPercent = (v: number | null): string => formatMaybe(v, (n) => `${n.toFixed(1)} %`)

export const fmtText = (v: string | null): string => formatMaybe(v, (s) => s)
