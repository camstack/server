import type { NcLanguage } from './text-catalog.js'

/**
 * `{{time}}` — hours and minutes in the NOTIFICATION language.
 *
 * It used to be `toLocaleTimeString()` in the server's own locale, so an
 * Italian hub running an English container sent "8:05:13 PM" inside an
 * Italian sentence. The time zone is the host's unless a caller (a spec)
 * pins one.
 */
export function ncClockText(language: NcLanguage, atMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).format(new Date(atMs))
}
