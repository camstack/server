import { z } from 'zod'

/**
 * Optional callback invoked when `fromSchema` had to drop one or
 * more persisted fields to recover from a Zod validation failure.
 * Used by `BaseDevice` to surface the action via the device logger.
 */
export type ConfigRecoveryListener = (info: {
  droppedKeys: readonly string[]
  issues: readonly z.core.$ZodIssue[]
}) => void

export class DeviceConfig<T extends z.ZodObject<z.core.$ZodLooseShape>> {
  readonly schema: T
  private data: z.infer<T>
  private readonly persistFn: (data: z.infer<T>) => Promise<void>

  private constructor(schema: T, data: z.infer<T>, persist: (data: z.infer<T>) => Promise<void>) {
    this.schema = schema
    this.data = data
    this.persistFn = persist
  }

  /**
   * Build a `DeviceConfig` from a persisted blob, with automatic
   * recovery from schema-validation failures. Boot must never be
   * blocked by stale persisted values: if Zod rejects the blob,
   * we drop every offending top-level field, retry, and persist
   * the cleaned blob so the bad value is healed in the DB on next
   * write. The most common trigger is a tightened range constraint
   * (e.g. `max(100) → max(50)`) on a field that already has an
   * out-of-range value persisted from the previous schema. Without
   * this safety net, the device would fail to instantiate and end
   * up with no caps registered — exactly the failure mode that
   * stranded device 15 when `motionSensitivity: 90` no longer fit
   * the new `1..50` schema.
   *
   * Recovery rules:
   *  1. Try `safeParse(initialData)`. If it succeeds, done.
   *  2. On failure, walk `error.issues`, collect the top-level path
   *     of each issue, and drop those keys from `initialData`.
   *  3. Re-run `safeParse`. If the cleaned blob now passes (Zod
   *     fills the missing keys with schema defaults / undefined for
   *     `.optional()`), persist it via `persist()` so the bad
   *     values disappear from the DB, and return the device.
   *  4. If the cleaned blob STILL fails (very rare — would require
   *     a non-recoverable required field), fall back to
   *     `schema.parse({})` so the device still boots with pure
   *     schema defaults. Persist nothing in that path so the next
   *     successful `setAll` still writes a coherent blob.
   */
  static fromSchema<T extends z.ZodObject<z.core.$ZodLooseShape>>(
    schema: T,
    persist: (data: z.infer<T>) => Promise<void>,
    initialData: Record<string, unknown> = {},
    onRecover?: ConfigRecoveryListener,
  ): DeviceConfig<T> {
    const first = schema.safeParse(initialData)
    if (first.success) {
      return new DeviceConfig(schema, first.data as z.infer<T>, persist)
    }

    const droppedKeys = new Set<string>()
    for (const issue of first.error.issues) {
      const top = issue.path[0]
      if (typeof top === 'string') droppedKeys.add(top)
    }

    const cleaned: Record<string, unknown> = { ...initialData }
    for (const k of droppedKeys) delete cleaned[k]
    const second = schema.safeParse(cleaned)

    onRecover?.({
      droppedKeys: [...droppedKeys],
      issues: first.error.issues,
    })

    if (second.success) {
      // Heal the DB: persist the cleaned blob asynchronously so the
      // offending fields are gone on next read. Best-effort — a
      // persist failure here doesn't block boot, the device still
      // runs from the in-memory cleaned data.
      void persist(second.data as z.infer<T>).catch(() => {
        /* swallow */
      })
      return new DeviceConfig(schema, second.data as z.infer<T>, persist)
    }

    // Last-resort fallback: pure schema defaults. This branch should
    // be unreachable for well-formed schemas (every required field
    // must already be in `initialData`, and `.optional()` fields
    // accept undefined), but is here so a malformed blob can't
    // strand the device.
    const defaults = schema.parse({}) as z.infer<T>
    return new DeviceConfig(schema, defaults, persist)
  }

  get values(): z.infer<T> {
    return this.data
  }

  get<K extends keyof z.infer<T>>(key: K): z.infer<T>[K] {
    return this.data[key]
  }

  async set<K extends keyof z.infer<T>>(key: K, value: z.infer<T>[K]): Promise<void> {
    const next = this.schema.parse({ ...this.data, [key]: value })
    this.data = next
    await this.persistFn(this.data)
  }

  /**
   * Merge an untyped patch onto the current config and persist. Accepts
   * `Record<string, unknown>` because the patch typically comes from the
   * UI form layer (a `ConfigField.key → value` map) where the caller
   * doesn't hold the Zod schema's static type. Runtime validation is
   * authoritative: `this.schema.parse` rejects unknown keys or invalid
   * shapes before touching storage.
   */
  async setAll(partial: Record<string, unknown>): Promise<void> {
    const next = this.schema.parse({ ...this.data, ...partial })
    this.data = next
    await this.persistFn(this.data)
  }

  async deleteKey<K extends keyof z.infer<T>>(key: K): Promise<void> {
    const { [key as string]: _, ...rest } = this.data as Record<string, unknown>
    const next = this.schema.parse(rest)
    this.data = next
    await this.persistFn(this.data)
  }

  entries(): Array<{
    key: string
    schema: z.ZodType
    value: unknown
    description?: string
  }> {
    const shape = this.schema.shape as Record<string, z.ZodType>
    return Object.entries(shape).map(([key, fieldSchema]) => ({
      key,
      schema: fieldSchema,
      value: this.data[key as keyof z.infer<T>],
      description: fieldSchema.description,
    }))
  }
}
