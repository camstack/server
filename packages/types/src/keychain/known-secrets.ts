/**
 * The per-process set of secret VALUES this process has resolved, so the log
 * pipeline can scrub them wherever they turn up — a library's error message,
 * an argv a spawn logged, a URL someone interpolated.
 *
 * Key-name redaction cannot catch `Command failed: cloudflared --token eyJ…`:
 * the value is in a message, not under a named key. The only thing that can is
 * knowing the value. `ctx.secrets` registers every value it resolves (and every
 * value it stores), and `scrubKnownSecrets` replaces each occurrence with
 * `‹secret:<hash of its ref>›` — enough to say WHICH secret leaked, nothing of
 * what it is.
 *
 * Process-global on purpose: a forked runner scrubs its own logs before they
 * leave over UDS, and hub-main scrubs what it resolved. Values shorter than
 * {@link MIN_SCRUBBED_LENGTH} are not registered — a 4-digit PIN would turn
 * every timestamp containing it into a redaction.
 */

/** Below this length a value is too likely to collide with ordinary text. */
export const MIN_SCRUBBED_LENGTH = 8

interface KnownSecretStore {
  readonly values: Map<string, string>
  compiled: RegExp | null
}

/**
 * One store per PROCESS, even when two copies of this module are loaded (an
 * addon bundle next to the framework's): keyed on a registered symbol.
 */
const STORE_KEY = Symbol.for('camstack.keychain.known-secrets')

function store(): KnownSecretStore {
  const existing: unknown = Reflect.get(globalThis, STORE_KEY)
  if (existing !== undefined && existing !== null) return existing as KnownSecretStore // documented boundary: our own registered-symbol slot
  const created: KnownSecretStore = { values: new Map(), compiled: null }
  Reflect.set(globalThis, STORE_KEY, created)
  return created
}

/** FNV-1a, 32-bit, as 8 hex chars — a label, not a security property. */
export function shortSecretRefHash(ref: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < ref.length; i++) {
    hash ^= ref.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function recompile(): void {
  const s = store()
  if (s.values.size === 0) {
    s.compiled = null
    return
  }
  // Longest first, so a value that contains another is replaced whole.
  const values = [...s.values.keys()].toSorted((a, b) => b.length - a.length)
  s.compiled = new RegExp(values.map(escapeRegExp).join('|'), 'g')
}

/** Remember a value this process holds. A no-op for short or empty values. */
export function registerKnownSecret(value: string, ref: string): void {
  if (value.length < MIN_SCRUBBED_LENGTH) return
  const label = `‹secret:${shortSecretRefHash(ref)}›`
  const values = store().values
  if (values.get(value) === label) return
  values.set(value, label)
  recompile()
}

/** Forget a value (it was replaced or deleted). */
export function forgetKnownSecret(value: string): void {
  if (!store().values.delete(value)) return
  recompile()
}

/** How many values are registered — for tests and the status page. */
export function knownSecretCount(): number {
  return store().values.size
}

/** Test seam: drop every registered value. */
export function clearKnownSecrets(): void {
  const s = store()
  s.values.clear()
  s.compiled = null
}

/** Replace every registered value inside `text` with its label. */
export function scrubKnownSecrets(text: string): string {
  const s = store()
  const re = s.compiled
  if (re === null || text.length < MIN_SCRUBBED_LENGTH) return text
  re.lastIndex = 0
  if (!re.test(text)) return text
  re.lastIndex = 0
  return text.replace(re, (match) => s.values.get(match) ?? '‹secret›')
}
