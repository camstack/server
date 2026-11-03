/**
 * The scrubber of `report_issue`: a pure, stateful-per-draft redactor that every
 * string of the issue goes through, with a count per kind of thing removed.
 *
 * Nothing here knows about the hub: the caller hands it the names it must hide
 * (devices, nodes) and reads the counts back for the "redacted: …" line. The
 * order of the passes matters and is the order below: a credential is removed
 * before the URL that carries it is shortened, a URL before the hostname and
 * address passes, and names last.
 */

export const REDACTION_KINDS = [
  'tokens',
  'secretMarkers',
  'credentials',
  'rtspCredentials',
  'urls',
  'emails',
  'macs',
  'ipv4',
  'ipv6',
  'hostnames',
  'homePaths',
  'names',
] as const

export type RedactionKind = (typeof REDACTION_KINDS)[number]

export type RedactionCounts = { readonly [K in RedactionKind]: number }

/** A name to hide and what replaces it (`device#12`, `node#1`). */
export interface KnownName {
  readonly name: string
  readonly label: string
}

export interface Redactor {
  /** One string, ready for a public issue. */
  readonly scrub: (input: string) => string
  /** What was removed so far, by kind. */
  readonly counts: () => RedactionCounts
}

const SECRET_MARKER = /secret:\/\/[^\s"'<>`)\]]+/g

const TOKEN_SHAPES: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\bBearer\s+[A-Za-z0-9._\-+=/]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/g,
  /\bcsa_[A-Za-z0-9_-]{6,}/g,
  /\bcfm_[A-Fa-f0-9]{8,}/g,
  /\bglsa_[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
]

const SECRET_KEYS =
  'password|passwd|pwd|pass|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth|authorization|cookie|session|key|user|username|login|email'

// `"token": "x"`, `token=x`, `?key=x&…`, `password: x`. A value already
// replaced by an earlier pass starts with `[redacted` and is left alone.
const KEY_VALUE = new RegExp(
  `(\\b(?:${SECRET_KEYS})["']?\\s*[:=]\\s*)(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s,;&"'}\\])]+))`,
  'gi',
)

const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s'"<>`)\]]+/gi
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g
const MAC = /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g
// Four or more colons (a clock time has two), a compressed `::` between hex
// groups, or a leading `::` (loopback and friends).
const IPV6 =
  /\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}(?![\w:])|\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6}::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?(?![\w:])|(?<![\w:])::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})(?![\w:])/g
const HOME_POSIX = /(\/Users|\/home)\/[^/\s'"`:]+/g
const HOME_WINDOWS = /\b([A-Za-z]:\\Users)\\[^\\\s'"`]+/g
const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})\b/gi

/**
 * A dotted word is a hostname only when its last label is a real top-level (or
 * a home-network) label: `ctx.api`, `index.ts` and `Object.keys` are code.
 */
const HOST_TLDS: ReadonlySet<string> = new Set([
  'com',
  'net',
  'org',
  'io',
  'dev',
  'app',
  'cloud',
  'info',
  'xyz',
  'me',
  'co',
  'ai',
  'eu',
  'us',
  'uk',
  'it',
  'de',
  'fr',
  'es',
  'nl',
  'ch',
  'at',
  'be',
  'ru',
  'local',
  'lan',
  'home',
  'internal',
  'localdomain',
  'arpa',
])

const NAME_MIN_LENGTH = 3

/** Words the draft itself prints (`(hub)`): hiding them would garble the text and hides nothing. */
const GENERIC_NAMES: ReadonlySet<string> = new Set([
  'hub',
  'node',
  'agent',
  'server',
  'camera',
  'device',
])

function emptyCounts(): { [K in RedactionKind]: number } {
  return {
    tokens: 0,
    secretMarkers: 0,
    credentials: 0,
    rtspCredentials: 0,
    urls: 0,
    emails: 0,
    macs: 0,
    ipv4: 0,
    ipv6: 0,
    hostnames: 0,
    homePaths: 0,
    names: 0,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f-]{8,}|(?=.*\d)(?=.*[a-z])[a-z0-9_-]{8,}|.{24,})$/i

/** `https://host/a/123/b?x=1` becomes `[url]/a/:id/b`: the shape, no host, no query. */
function urlShape(raw: string): { shape: string; hadCredentials: boolean } {
  const withoutScheme = raw.slice(raw.indexOf('://') + 3)
  const authorityEnd = withoutScheme.search(/[/?#]/)
  const authority = authorityEnd === -1 ? withoutScheme : withoutScheme.slice(0, authorityEnd)
  const rest = authorityEnd === -1 ? '' : withoutScheme.slice(authorityEnd)
  const path = rest.split(/[?#]/)[0] ?? ''
  const segments = path
    .split('/')
    .map((s) => (ID_SEGMENT.test(s) ? ':id' : s))
    .join('/')
  return { shape: `[url]${segments}`, hadCredentials: authority.includes('@') }
}

/** A redactor for one draft. `names` are hidden wherever they appear, case-insensitively. */
export function createRedactor(names: readonly KnownName[] = []): Redactor {
  const counts = emptyCounts()
  const usable = names
    .filter(
      (n) =>
        n.name.trim().length >= NAME_MIN_LENGTH &&
        !GENERIC_NAMES.has(n.name.trim().toLowerCase()) &&
        !/^\d+$/.test(n.name.trim()),
    )
    .toSorted((a, b) => b.name.length - a.name.length)
  const labelOf = new Map(usable.map((n) => [n.name.trim().toLowerCase(), n.label]))
  const nameRe =
    usable.length === 0
      ? null
      : new RegExp(
          `(?<![\\p{L}\\p{N}])(?:${usable.map((n) => escapeRegExp(n.name.trim())).join('|')})(?![\\p{L}\\p{N}])`,
          'giu',
        )

  const scrub = (input: string): string => {
    let out = input
    out = out.replace(SECRET_MARKER, () => {
      counts.secretMarkers += 1
      return '[redacted:secret]'
    })
    for (const shape of TOKEN_SHAPES) {
      out = out.replace(shape, () => {
        counts.tokens += 1
        return '[redacted:token]'
      })
    }
    out = out.replace(
      KEY_VALUE,
      (whole: string, head: string, dq?: string, sq?: string, bare?: string) => {
        const value = dq ?? sq ?? bare ?? ''
        if (value.startsWith('[redacted') || value === '') return whole
        counts.credentials += 1
        const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : ''
        return `${head}${quote}[redacted:value]${quote}`
      },
    )
    out = out.replace(URL_RE, (raw) => {
      const { shape, hadCredentials } = urlShape(raw)
      if (hadCredentials) counts.rtspCredentials += 1
      counts.urls += 1
      return shape
    })
    out = out.replace(EMAIL, () => {
      counts.emails += 1
      return '[redacted:email]'
    })
    out = out.replace(MAC, () => {
      counts.macs += 1
      return '[redacted:mac]'
    })
    out = out.replace(IPV6, () => {
      counts.ipv6 += 1
      return '[redacted:ipv6]'
    })
    out = out.replace(IPV4, () => {
      counts.ipv4 += 1
      return '[redacted:ip]'
    })
    out = out.replace(HOME_POSIX, (_m, root: string) => {
      counts.homePaths += 1
      return `${root}/~`
    })
    out = out.replace(HOME_WINDOWS, (_m, root: string) => {
      counts.homePaths += 1
      return `${root}\\~`
    })
    out = out.replace(HOSTNAME, (host: string, tld: string) => {
      if (!HOST_TLDS.has(tld.toLowerCase())) return host
      counts.hostnames += 1
      return '[redacted:host]'
    })
    if (nameRe !== null) {
      out = out.replace(nameRe, (hit) => {
        counts.names += 1
        return labelOf.get(hit.trim().toLowerCase()) ?? '[redacted:name]'
      })
    }
    return out
  }

  return { scrub, counts: () => ({ ...counts }) }
}

const COUNT_LABELS: readonly {
  readonly label: string
  readonly kinds: readonly RedactionKind[]
}[] = [
  { label: 'IPs', kinds: ['ipv4', 'ipv6'] },
  { label: 'tokens', kinds: ['tokens'] },
  { label: 'secret markers', kinds: ['secretMarkers'] },
  { label: 'credential values', kinds: ['credentials'] },
  { label: 'RTSP/URL credentials', kinds: ['rtspCredentials'] },
  { label: 'URLs shortened', kinds: ['urls'] },
  { label: 'emails', kinds: ['emails'] },
  { label: 'MACs', kinds: ['macs'] },
  { label: 'hostnames', kinds: ['hostnames'] },
  { label: 'home paths', kinds: ['homePaths'] },
  { label: 'device/node names', kinds: ['names'] },
]

export function totalRedactions(counts: RedactionCounts): number {
  return REDACTION_KINDS.reduce((sum, kind) => sum + counts[kind], 0)
}

/** `redacted: 12 IPs, 3 tokens`, or `redacted: nothing`. */
export function describeRedactions(counts: RedactionCounts): string {
  const parts = COUNT_LABELS.map(({ label, kinds }) => ({
    label,
    n: kinds.reduce((sum, k) => sum + counts[k], 0),
  }))
    .filter((p) => p.n > 0)
    .map((p) => `${String(p.n)} ${p.label}`)
  return parts.length === 0 ? 'redacted: nothing' : `redacted: ${parts.join(', ')}`
}
