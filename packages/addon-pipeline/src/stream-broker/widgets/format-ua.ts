/**
 * Compact a raw User-Agent string into a `Browser/OS` chip for the
 * stream-broker SUBSCRIBERS panel. Pure, dependency-free, deterministic —
 * the goal is a LEAN operator-readable tag (e.g. "Chrome/macOS",
 * "Safari/iOS"), not exhaustive UA parsing. Falls back to a truncated raw
 * string when neither browser nor OS can be recognised.
 */

const MAX_RAW_LENGTH = 24

function detectBrowser(ua: string): string | null {
  // Order matters: Edge (`Edg`) and Opera (`OPR`) both also carry
  // `Chrome` in their UA, and Chrome carries `Safari` — check the most
  // specific tokens first.
  if (/\bEdg\b|\bEdgA\b|\bEdgiOS\b|Edge\//.test(ua)) return 'Edge'
  if (/\bOPR\b|Opera/.test(ua)) return 'Opera'
  if (/Firefox\/|\bFxiOS\b/.test(ua)) return 'Firefox'
  if (/Chrome\/|\bCriOS\b/.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return null
}

function detectOs(ua: string): string | null {
  if (/iPhone|iPad|iPod|\biOS\b|CriOS|FxiOS/.test(ua)) return 'iOS'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Android/.test(ua)) return 'Android'
  if (/Linux/.test(ua)) return 'Linux'
  return null
}

/**
 * @param ua Raw User-Agent header value.
 * @returns A compact `Browser/OS` label, a single component when only one
 *          is recognised, or a truncated raw UA when neither parses.
 */
export function formatUa(ua: string): string {
  const trimmed = ua.trim()
  if (trimmed.length === 0) return ''
  const browser = detectBrowser(trimmed)
  const os = detectOs(trimmed)
  if (browser && os) return `${browser}/${os}`
  if (browser) return browser
  if (os) return os
  return trimmed.length > MAX_RAW_LENGTH ? `${trimmed.slice(0, MAX_RAW_LENGTH)}…` : trimmed
}
