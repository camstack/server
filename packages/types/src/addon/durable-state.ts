import type { ZodType } from 'zod'

/**
 * A typed handle over ONE top-level key of an addon/device store. `set`
 * always writes the whole Zod-validated value for that key, so a field
 * can never be silently dropped by a hand-written serializer. Sibling
 * keys are untouched (writes go through the store's patch-merge).
 */
export interface DurableState<T> {
  /** Read + validate. Missing key or parse failure → `fallback`. Never throws. */
  get(): Promise<T>
  /** Validate `next`, then write the WHOLE value under this key. Throws on invalid. */
  set(next: T): Promise<void>
  /** get → fn(prev) → set, as one logical update. */
  update(fn: (prev: T) => T): Promise<void>
}

export interface DurableStateDeps<T> {
  readonly key: string
  readonly schema: ZodType<T>
  readonly fallback: T
  readonly read: () => Promise<Record<string, unknown>>
  readonly write: (patch: Record<string, unknown>) => Promise<void>
  /** Called when a stored blob fails validation (before falling back). */
  readonly onParseError?: (key: string, error: unknown) => void
}

/**
 * Build a {@link DurableState} over a single store key. Transport-agnostic:
 * `read`/`write` are the addon-store or device-store accessors. The whole
 * validated value round-trips on every read/write — the schema is the
 * single source of truth for what is persisted, so no hand-listed field
 * set can drop a key on save.
 */
export function createDurableState<T>(deps: DurableStateDeps<T>): DurableState<T> {
  const get = async (): Promise<T> => {
    const store = await deps.read()
    const raw = store[deps.key]
    if (raw === undefined) return deps.fallback
    const parsed = deps.schema.safeParse(raw)
    if (!parsed.success) {
      deps.onParseError?.(deps.key, parsed.error)
      return deps.fallback
    }
    return parsed.data
  }

  const set = async (next: T): Promise<void> => {
    const validated = deps.schema.parse(next)
    await deps.write({ [deps.key]: validated })
  }

  const update = async (fn: (prev: T) => T): Promise<void> => {
    await set(fn(await get()))
  }

  return { get, set, update }
}
