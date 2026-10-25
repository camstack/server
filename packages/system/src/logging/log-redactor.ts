/**
 * The central log redactor (D787 §8). Every line passes through it before any
 * destination, ring buffer or subscriber sees it — in hub-main's `LogManager`,
 * in a forked runner's UDS logger (which alone knows the values that runner
 * resolved), and on an agent before a child's line is forwarded to the hub.
 *
 * Three nets, cheapest first:
 *  1. KNOWN VALUES — every secret this process resolved through `ctx.secrets`
 *     is replaced wherever it appears (`‹secret:<ref hash>›`). The only net
 *     that catches a value inside a library's error message.
 *  2. URL CREDENTIALS — `user:pass@` and credential query params in any URL
 *     inside a string (`maskUrlCredentials`), and the value after a
 *     credential-looking CLI flag (`--token X`, `--auth-key=X`).
 *  3. KEY NAMES — a `meta` value under a credential-named key, at any depth.
 *
 * Key names are a LOG heuristic only: whether a field is STORED in the
 * keychain is decided by its schema type, never by its name.
 *
 * Hot path: a line with no meta, no `://`, no `--` and no registered values
 * costs a few `includes` checks.
 */
import type { LogEntry } from '@camstack/types'
import { maskUrlCredentials, scrubKnownSecrets } from '@camstack/types/addon'

const REDACTED = '***'

/** Credential-named keys. Substring, case-insensitive; only STRING values are replaced. */
const SECRET_KEY_SUBSTRINGS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authkey',
  'auth_key',
  'privatekey',
  'private_key',
  'passphrase',
  'credential',
  'cookie',
]

/** True when a meta key names a credential. */
export function isCredentialKeyName(key: string): boolean {
  const lower = key.toLowerCase()
  return SECRET_KEY_SUBSTRINGS.some((needle) => lower.includes(needle))
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi
/** A root-relative path WITH a query, as request logs print it. */
const RELATIVE_URL_IN_TEXT = /(^|[\s"'(=])(\/[^\s"'<>`?]*\?[^\s"'<>`]+)/g
const CREDENTIAL_FLAG =
  /(--(?:token|auth-?key|password|passwd|pass|secret|api-?key|access-?token|refresh-?token)(?:=|\s+))(\S+)/gi

/** Redact one free-form string. */
export function redactLogText(text: string): string {
  let out = scrubKnownSecrets(text)
  if (out.includes('://')) out = out.replace(URL_IN_TEXT, (url) => maskUrlCredentials(url))
  if (out.includes('/') && out.includes('?') && out.includes('=')) {
    out = out.replace(
      RELATIVE_URL_IN_TEXT,
      (_m, lead: string, path: string) => `${lead}${maskUrlCredentials(path)}`,
    )
  }
  if (out.includes('--')) {
    // A value the known-value net already labelled keeps its label — it says
    // WHICH secret it was, which `***` would throw away.
    out = out.replace(CREDENTIAL_FLAG, (_m, flag: string, value: string) =>
      value.startsWith('‹secret:') ? `${flag}${value}` : `${flag}${REDACTED}`,
    )
  }
  return out
}

/** Bounds on the meta walk — a log line is not a place to traverse a graph. */
const MAX_DEPTH = 8
const MAX_NODES = 2_000

interface WalkBudget {
  nodes: number
}

/**
 * Redact a value, returning the SAME reference when nothing in it changed —
 * most lines carry clean meta, and copying every one would put an allocation
 * per log line on hub-main's event loop.
 */
function redactValue(
  value: unknown,
  depth: number,
  budget: WalkBudget,
  seen: WeakSet<object>,
): unknown {
  if (budget.nodes++ > MAX_NODES) return value
  if (typeof value === 'string') return redactLogText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH || seen.has(value)) return value
  if (value instanceof Error) {
    const message = redactLogText(value.message)
    return message === value.message ? value : message
  }
  if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return value
  seen.add(value)
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i]
      const next = redactValue(item, depth + 1, budget, seen)
      if (next !== item) {
        copy ??= [...value]
        copy[i] = next
      }
    }
    return copy ?? value
  }
  let copy: Record<string, unknown> | null = null
  for (const [key, child] of Object.entries(value)) {
    const next =
      typeof child === 'string' && child.length > 0 && isCredentialKeyName(key)
        ? REDACTED
        : redactValue(child, depth + 1, budget, seen)
    if (next !== child) {
      copy ??= { ...value }
      copy[key] = next
    }
  }
  return copy ?? value
}

/** Redact a `meta` record; the same object back when it was already clean. */
export function redactLogMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out = redactValue(meta, 0, { nodes: 0 }, new WeakSet())
  if (out === meta) return meta
  return out !== null && typeof out === 'object' && !Array.isArray(out)
    ? Object.fromEntries(Object.entries(out))
    : meta
}

/** Redact a whole entry: message and meta. Tags are identifiers, left alone. */
export function redactLogEntry(entry: LogEntry): LogEntry {
  const message = redactLogText(entry.message)
  const meta = entry.meta !== undefined ? redactLogMeta(entry.meta) : undefined
  if (message === entry.message && meta === entry.meta) return entry
  return { ...entry, message, ...(meta !== undefined ? { meta } : {}) }
}
