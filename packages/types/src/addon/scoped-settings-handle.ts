import type { ZodType } from 'zod'
import type { ScopedSettings } from './scoped-settings.js'

/** What a {@link ScopedSettings} handle needs from the addon that owns the store. */
export interface ScopedSettingsDeps<T> {
  readonly schema: ZodType<T>
  /** Stored values narrowed to the declared keys, secrets resolved, schema defaults underneath. */
  readonly read: () => Promise<Record<string, unknown>>
  /** The keys the capability declared for this scope. */
  readonly declaredKeys: () => Promise<ReadonlySet<string>>
  /** Write `patch` (a value of `undefined` removes the key). */
  readonly write: (patch: Record<string, unknown>) => Promise<void>
}

async function refuseUndeclared(
  keys: readonly string[],
  deps: Pick<ScopedSettingsDeps<unknown>, 'declaredKeys'>,
): Promise<void> {
  const declared = await deps.declaredKeys()
  const undeclared = keys.filter((key) => !declared.has(key))
  if (undeclared.length > 0) {
    throw new Error(
      `scoped settings: [${undeclared.join(', ')}] not declared for this scope ` +
        `(declared: [${[...declared].join(', ')}])`,
    )
  }
}

/** Build the handle over an addon's scoped read and write. */
export function createScopedSettings<T>(deps: ScopedSettingsDeps<T>): ScopedSettings<T> {
  return {
    async get() {
      return deps.schema.parse(await deps.read())
    },
    async patch(patch) {
      const entries = Object.entries(patch)
      await refuseUndeclared(
        entries.map(([key]) => key),
        deps,
      )
      await deps.write(Object.fromEntries(entries))
    },
    async unset(keys) {
      await refuseUndeclared(keys, deps)
      await deps.write(Object.fromEntries(keys.map((key) => [key, undefined])))
    },
  }
}
