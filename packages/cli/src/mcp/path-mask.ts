/**
 * Masking of file-system paths for text that leaves the machine: the mount shape
 * stays (it explains a setup: `/mnt/…/events`, `C:\Users\…\events`), the names
 * in between go. A path can carry a user name, a share, a host or a pasted
 * `user:password@host`, so the rule is "first segment, an ellipsis, the last
 * segment" and nothing else, for short paths too.
 */

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i
const SCHEMELESS_CREDENTIALS = /^\/\/[^/\\\s]*@/
const UNC = /^\\\\[^\\/]+[\\/]?/
const DRIVE = /^[A-Za-z]:[\\/]?/

/** One path, masked. Never throws; a value that is not a path is returned as `[remote]`-safe text. */
export function maskPath(raw: string): string {
  if (URL_LIKE.test(raw) || SCHEMELESS_CREDENTIALS.test(raw)) return '[remote url]'
  let prefix = '/'
  let rest = raw
  let sep = '/'
  const unc = UNC.exec(raw)
  const drive = DRIVE.exec(raw)
  if (unc) {
    prefix = '\\\\[host]\\'
    sep = '\\'
    rest = raw.slice(unc[0].length)
  } else if (drive) {
    prefix = `${raw.slice(0, 2)}\\`
    sep = '\\'
    rest = raw.slice(drive[0].length)
  } else if (!raw.startsWith('/')) {
    prefix = ''
  }
  const segments = rest.split(/[\\/]/).filter((s) => s !== '')
  const first = segments[0]
  if (first === undefined) return prefix === '' ? '' : prefix
  // A relative path has no mount shape to keep: its first segment is just a name.
  if (prefix === '') return `…${sep}${segments[segments.length - 1] ?? first}`
  if (segments.length === 1) return `${prefix}${first}`
  if (segments.length === 2) return `${prefix}${first}${sep}…`
  return `${prefix}${first}${sep}…${sep}${segments[segments.length - 1] ?? ''}`
}

/** A scheme-less `//user:password@host/share`: the credentials and the host. */
export const SCHEMELESS_URL_IN_TEXT = /(?<![\w:])\/\/[^/\\\s'"`@]+@[^\s'"`<>)\]]+/g

/** Absolute paths under the roots an install really mounts storage on. */
export const POSIX_PATH_IN_TEXT =
  /(?<![\w:./~-])\/(?:mnt|data|srv|media|volume\d*|share|Volumes|var|opt|root|config|tmp|run|app)(?:\/[^\s'"`:;,)\]<>]+)+/g

export const WINDOWS_PATH_IN_TEXT = /\b[A-Za-z]:\\(?:[^\\\s'"`<>|]+\\)*[^\\\s'"`<>|]+/g

export const UNC_PATH_IN_TEXT = /\\\\[^\\\s'"`]+(?:\\[^\\\s'"`]+)+/g
