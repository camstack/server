/**
 * Browser-origin helpers shared by the CORS policy (`server/backend`, read
 * side) and the `auth.corsOrigins` writer (`system-config`, write side), so
 * both judge an entry the same way (D707).
 */

/**
 * The serialisation of an opaque origin. The native app's OTA embed
 * (`assets/embed/camstack-embed.html`, loaded from `file://`) sends it.
 */
export const OPAQUE_ORIGIN = 'null'

/**
 * The canonical serialisation of an origin (`scheme://host[:port]`, lower
 * case, default port dropped), or `null` when `raw` is not an http(s) origin.
 * `null` (the opaque origin) is accepted verbatim.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === OPAQUE_ORIGIN) return OPAQUE_ORIGIN
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  // An origin has no path, query, fragment or credentials. Accept a bare
  // trailing slash (a common paste), refuse anything that names more.
  if (url.username !== '' || url.password !== '') return null
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    return null
  }
  return url.origin
}

/** A stored setting as a string list — accepts a list, or one comma/space separated string. */
export function readOriginSetting(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return value.split(/[\s,]+/).filter((v) => v.length > 0)
  return []
}

/** A list of origin entries, split into the normalised usable ones and the rest. */
export interface ParsedOriginList {
  readonly origins: readonly string[]
  readonly rejected: readonly string[]
}

export function parseOriginList(entries: readonly string[]): ParsedOriginList {
  const origins: string[] = []
  const rejected: string[] = []
  for (const entry of entries) {
    if (entry.trim().length === 0) continue
    const normalized = normalizeOrigin(entry)
    if (normalized === null) rejected.push(entry)
    else origins.push(normalized)
  }
  return { origins, rejected }
}

/**
 * Is `origin` (already normalised) plain http to somewhere other than this
 * machine? Such an origin sends its bearer token in clear over the network.
 */
export function isInsecureOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]'
}

/** A save of `auth.corsOrigins` named entries that are not http(s) origins. */
export class InvalidCorsOriginError extends Error {
  readonly invalid: readonly string[]
  constructor(invalid: readonly string[]) {
    super(`Not an http(s) origin (scheme://host[:port], no path): ${invalid.join(', ')}`)
    this.name = 'InvalidCorsOriginError'
    this.invalid = invalid
  }
}
