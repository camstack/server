/**
 * Type-safe JSON parsing helpers.
 *
 * `JSON.parse` is typed as `any` in lib.es5.d.ts, which triggers
 * `no-unsafe-*` ESLint rules and destroys downstream inference. These
 * wrappers return `unknown` — callers narrow structurally via type
 * guards, `typeof` checks, or helpers like `asRecord`/`asString`.
 */

/**
 * Parse JSON and return it as `unknown` — the only entry point for untrusted JSON.
 *
 * The optional generic overload `parseJsonUnknown<T>(text)` returns `T` for
 * call sites that know the shape at parse time (e.g. MQTT payloads with a
 * known protocol schema). This is a **type-level bridge only** — no runtime
 * validation is performed. Callers that need runtime validation should parse
 * as `unknown` and narrow via Zod or structural guards.
 */
export function parseJsonUnknown<T = unknown>(text: string): T {
  // Isolate JSON.parse's `any` to this single statement.
  const parsed: unknown = JSON.parse(text)
  return parsed as T
}

/** Narrow an unknown value to a plain `Record<string, unknown>` or return null. */
export function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return { ...value }
}

/** Narrow an unknown value to a `readonly unknown[]` or return an empty array. */
export function asJsonArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** Safe string extraction from an unknown record field. */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Safe number extraction from an unknown record field. */
export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback
}

/** Safe boolean extraction from an unknown record field. */
export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Parse JSON + narrow to object in one step. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asJsonObject(parseJsonUnknown(text))
  } catch {
    return null
  }
}

/** Parse JSON + narrow to array in one step. */
export function parseJsonArray(text: string): readonly unknown[] | null {
  try {
    const parsed = parseJsonUnknown(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
