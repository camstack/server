/**
 * The vocabulary of scoped addon settings (D986). No addon-level settings: every value is
 * declared by a capability the addon provides, in exactly ONE scope, and stored in one of the
 * existing settings tables.
 *
 * | scope            | declared by                      | row (`addon-settings` unless noted)      |
 * | ---------------- | -------------------------------- | ---------------------------------------- |
 * | `cluster`        | `clusterSettingsSchema(cap)`     | `<addonId>.<field>`                      |
 * | `device-defaults`| `deviceDefaultsSchema(cap)`      | `<addonId>.<field>` (the fleet default)  |
 * | `node`           | `nodeSettingsSchema(cap)`        | `<addonId>.<field>@<nodeId>` + `nodeId`  |
 * | device override  | the cap's device form (D14)      | `addon-device-settings`                  |
 *
 * Pure functions, no I/O, no imports: a LEAF module, reachable from the light
 * `@camstack/types/addon` entry so a forked runner pulls no schema graph for it.
 */

/** The scopes a capability provider declares a schema for. */
export type ScopedSettingsScope = 'cluster' | 'device-defaults' | 'node'

/**
 * One scoped schema an addon actually serves: the capability that declares it, the scope, and the
 * ids of its sections (what a settings surface filters on).
 */
export interface ScopedSettingsDeclaration {
  readonly cap: string
  readonly scope: ScopedSettingsScope
  readonly sectionIds: readonly string[]
}

/** Every scope, in the order the guard and the docs list them. */
export const SCOPED_SETTINGS_SCOPES: readonly ScopedSettingsScope[] = [
  'cluster',
  'device-defaults',
  'node',
]

/**
 * The node id a node-scoped KEY carries: the part after the `@`. `null` for a key with no `@`
 * (a cluster or fleet-default key) or an empty node id. A schema key never contains `@`
 * (guard `check-scoped-settings-declared`), so the first `@` is the separator.
 */
export function nodeIdOfScopedKey(key: string): string | null {
  const at = key.indexOf('@')
  if (at <= 0) return null
  const nodeId = key.slice(at + 1)
  return nodeId === '' ? null : nodeId
}

/** Where one resolved field's value came from. */
export type SettingSource = 'device' | 'fleet-default' | 'schema-default'

/** One field of a device's effective settings: the value and who supplied it. */
export interface ResolvedSetting {
  readonly value: unknown
  readonly source: SettingSource
}

/** Every field of a device's effective settings. */
export type ResolvedSettings = Readonly<Record<string, ResolvedSetting>>

/** What {@link resolveDeviceSettings} reads. Each layer is a plain key to value map. */
export interface DeviceSettingsLayers {
  /** The schema defaults of the device form's fields. Names the set of fields resolved. */
  readonly schemaDefaults: Readonly<Record<string, unknown>>
  /** The fleet-default rows (`addon-settings`, `<addonId>.<field>`), raw. */
  readonly fleetDefaults: Readonly<Record<string, unknown>>
  /** The device's own rows (`addon-device-settings`), raw. */
  readonly deviceOverrides: Readonly<Record<string, unknown>>
}

/**
 * The order D986 point 3 sets: device row, then fleet-default row, then schema default.
 * A layer wins when it HAS the key (an explicit `null` is a value; `undefined` is absent), so
 * an override equal to the default stays an override. Fields named by no layer are not
 * resolved; a stored key outside the schema (a stray device row) is carried with its source,
 * because dropping it would hide what the store holds.
 */
export function resolveDeviceSettings(layers: DeviceSettingsLayers): ResolvedSettings {
  const out: Record<string, ResolvedSetting> = {}
  for (const [key, value] of Object.entries(layers.schemaDefaults)) {
    out[key] = { value, source: 'schema-default' }
  }
  for (const [key, value] of Object.entries(layers.fleetDefaults)) {
    if (value === undefined || key.includes('@')) continue
    if (!(key in layers.schemaDefaults)) continue
    out[key] = { value, source: 'fleet-default' }
  }
  for (const [key, value] of Object.entries(layers.deviceOverrides)) {
    if (value === undefined) continue
    out[key] = { value, source: 'device' }
  }
  return out
}

/** The plain `key -> value` view of a resolution, for a caller that does not need the source. */
export function resolvedValues(resolved: ResolvedSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, setting] of Object.entries(resolved)) out[key] = setting.value
  return out
}

/**
 * The typed handle an addon reads and writes ONE scope of one capability through
 * (`clusterSettings`, `deviceDefaults`, `nodeSettings`). `T` is the value shape the addon
 * parses; the keys of a read, a patch and an unset are the ones the capability DECLARED for that
 * scope — anything else is refused, never stored.
 */
export interface ScopedSettings<T> {
  /** The stored values over the schema defaults, secrets resolved, parsed as `T`. */
  get(): Promise<T>
  /** Merge `patch` into the stored values (a secret is written as an ADDON write, D787). */
  patch(patch: Partial<T>): Promise<void>
  /** Remove stored keys, so the schema default applies again. */
  unset(keys: readonly (keyof T & string)[]): Promise<void>
}
