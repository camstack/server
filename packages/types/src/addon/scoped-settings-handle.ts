import type { ZodType } from 'zod'
import type { ScopedSettings } from './scoped-settings.js'

/** What a {@link ScopedSettings} handle needs from the addon that owns the store. */
export interface ScopedSettingsDeps<T> {
  readonly schema: ZodType<T>
  /** Stored values narrowed to the declared keys, secrets resolved, schema defaults underneath. */
  readonly read: () => Promise<Record<string, unknown>>
  /** Merge `patch`; the owner refuses keys the capability did not declare. */
  readonly write: (patch: Record<string, unknown>) => Promise<void>
  /** Remove stored keys (a secret's keychain value is released); same refusal. */
  readonly unset: (keys: readonly string[]) => Promise<void>
}

/** The one refusal of a key a scope did not declare. */
export function assertDeclaredKeys(keys: readonly string[], declared: ReadonlySet<string>): void {
  const undeclared = keys.filter((key) => !declared.has(key))
  if (undeclared.length > 0) {
    throw new Error(
      `scoped settings: [${undeclared.join(', ')}] not declared for this scope ` +
        `(declared: [${[...declared].join(', ')}])`,
    )
  }
}

/** Build the handle over an addon's scoped read, write and unset. */
export function createScopedSettings<T>(deps: ScopedSettingsDeps<T>): ScopedSettings<T> {
  return {
    async get() {
      return deps.schema.parse(await deps.read())
    },
    patch: (patch) => deps.write(Object.fromEntries(Object.entries(patch))),
    unset: (keys) => deps.unset(keys),
  }
}
