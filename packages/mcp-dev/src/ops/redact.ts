/**
 * What may leave an ops call: secret fields redacted by their DECLARATION, and
 * the payload bounded so a media blob or a 10k-row list never floods a context.
 *
 * Declarations (the repository's own, D783/D787):
 *   - a stored marker `{ "$secret": "secret://…", "v": 1 }` (or its UI view);
 *   - a config-UI field declared `type: 'password'` or `secret: true` — its
 *     `value`/`default` is the secret, whatever the key is called.
 * The output layer (`text()`) then adds the name/pattern scrub on top.
 */

export const REDACTED = '[SECRET]'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDeclaredSecretField(value: Record<string, unknown>): boolean {
  return value['type'] === 'password' || value['secret'] === true
}

/** A copy of `value` with every declared secret replaced; the input is untouched. */
export function redactDeclaredSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactDeclaredSecrets(v))
  if (!isRecord(value)) return value
  if (Object.prototype.hasOwnProperty.call(value, '$secret')) return REDACTED
  const declared = isDeclaredSecretField(value)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] =
      declared && (key === 'value' || key === 'default') ? REDACTED : redactDeclaredSecrets(child)
  }
  return out
}

export interface TruncateLimits {
  readonly maxItems: number
  readonly maxStringChars: number
  readonly maxTotalChars: number
}

export const DEFAULT_LIMITS: TruncateLimits = {
  maxItems: 100,
  maxStringChars: 1_000,
  maxTotalChars: 30_000,
}

export interface Truncated {
  readonly truncated: true
  readonly reason: string
  readonly totalChars: number
  readonly preview: string
}

function shrink(value: unknown, limits: TruncateLimits): unknown {
  if (typeof value === 'string') {
    return value.length > limits.maxStringChars
      ? `${value.slice(0, 80)}… [${value.length - 80} more chars omitted]`
      : value
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, limits.maxItems).map((v) => shrink(v, limits))
    return value.length > limits.maxItems
      ? [...head, { _omitted: `${value.length - limits.maxItems} more items` }]
      : head
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = shrink(v, limits)
    return out
  }
  return value
}

/**
 * Bound a payload: long strings (a base64 frame) are cut, long arrays are
 * capped, and a result still over the total budget becomes a labelled preview.
 */
export function truncateOutput(value: unknown, limits: TruncateLimits = DEFAULT_LIMITS): unknown {
  const shrunk = shrink(value, limits)
  const json = JSON.stringify(shrunk) ?? 'null'
  if (json.length <= limits.maxTotalChars) return shrunk
  return {
    truncated: true,
    reason: `result is ${json.length} chars, over the ${limits.maxTotalChars} budget — narrow the query (limit, window, ids)`,
    totalChars: json.length,
    preview: json.slice(0, limits.maxTotalChars),
  } satisfies Truncated
}

/** Redact then bound — the only way a hub payload becomes tool output. */
export function toToolOutput(value: unknown, limits: TruncateLimits = DEFAULT_LIMITS): unknown {
  return truncateOutput(redactDeclaredSecrets(value), limits)
}
