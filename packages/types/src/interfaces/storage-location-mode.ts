import { z } from 'zod'

/**
 * The storage-location STATE MODEL (D385) — one typed state, one policy module.
 *
 * A location's state used to be split across two authorities: the typed
 * `enabled` field (THE write switch since D383) and an untyped `config.readOnly`
 * key. They did not mean the same thing — `enabled: false` was still evicted
 * under disk pressure while `config.readOnly` was deliberately excluded — and
 * neither name said which. Every consumer re-derived the difference, and the
 * three questions that actually matter were answered in six places.
 *
 * This module is the ONLY place in the repo allowed to interpret the state. It
 * answers three questions and nothing else:
 *
 *   - may this location be WRITTEN to?   {@link modeMayWrite}
 *   - may this location be READ?          {@link modeMayRead}
 *   - what is its eviction policy?        {@link evictionPolicyForMode}
 *
 * | mode       | write | read | eviction                       |
 * | ---------- | ----- | ---- | ------------------------------ |
 * | `active`   | yes   | yes  | `normal` (pressure + usage cap) |
 * | `readonly` | no    | yes  | `never`                        |
 * | `drain`    | no    | yes  | `drain` (paced, until empty)   |
 * | `disabled` | no    | no   | `never`                        |
 *
 * `scripts/check-storage-location-mode-single-owner.ts` fails the build when
 * anything outside this module reads `config['readOnly']` or compares `enabled`
 * directly. A rule nothing checks has already been broken somewhere.
 */
export const STORAGE_LOCATION_MODES = ['active', 'readonly', 'drain', 'disabled'] as const

/**
 * The one typed state of a storage location. Authoritative Zod schema — the TS
 * alias below is `z.infer<>` of it, never a second spelling.
 */
export const StorageLocationModeSchema = z.enum(STORAGE_LOCATION_MODES)
export type StorageLocationMode = z.infer<typeof StorageLocationModeSchema>

/**
 * What disk-pressure and usage-cap relief may do to a location.
 *
 * - `normal` — the existing behaviour: free-percent guard plus `maxUsedGb`.
 * - `never`  — excluded entirely. A retiring disk the operator is copying off
 *              must not race the relocate mover, and a disabled one is not the
 *              system's to erase.
 * - `drain`  — a monotonically descending effective usage cap, paced to what
 *              the ACTIVE locations of the same class gained (D386). This is
 *              the only policy that shrinks a location the system is not
 *              writing to.
 */
export const StorageEvictionPolicySchema = z.enum(['normal', 'never', 'drain'])
export type StorageEvictionPolicy = z.infer<typeof StorageEvictionPolicySchema>

/**
 * The legacy untyped drain key. Named ONCE, here, so the guard has exactly one
 * sanctioned reader and the string never appears anywhere else.
 */
export const LEGACY_READ_ONLY_CONFIG_KEY = 'readOnly'

/**
 * The shape this module needs off a location row. Structural rather than
 * `StorageLocation` so the recorder's own resolved-location type, the admin
 * UI's row and a persisted row can all be asked the same three questions
 * without importing each other.
 */
export interface StorageLocationStateSource {
  /** The typed state, once stamped. Absent on a row written before D385. */
  readonly mode?: StorageLocationMode
  /** The retired write switch (D383). Read ONLY by the legacy fold below. */
  readonly enabled?: boolean
  /** The provider-facing config blob, which carried the retired drain key. */
  readonly config: Readonly<Record<string, unknown>>
}

/** Is this mode a write target? Only `active` is. */
export function modeMayWrite(mode: StorageLocationMode): boolean {
  return mode === 'active'
}

/** May this mode be read (playback, timeline, scrub, relocate source)? */
export function modeMayRead(mode: StorageLocationMode): boolean {
  return mode !== 'disabled'
}

/** What eviction may do here. See {@link StorageEvictionPolicy}. */
export function evictionPolicyForMode(mode: StorageLocationMode): StorageEvictionPolicy {
  switch (mode) {
    case 'active':
      return 'normal'
    case 'drain':
      return 'drain'
    case 'readonly':
    case 'disabled':
      return 'never'
  }
}

/**
 * The mode a LEGACY row implies, or `null` when it implies nothing — the row is
 * already stamped, or it carried neither flag.
 *
 * Both legacy flags fold to `readonly`, which is the CONSERVATIVE direction: a
 * state change must never start deleting footage on its own, and it must never
 * make footage that was still being served disappear. `enabled: false` used to
 * leave the location evictable under pressure; folding it to `readonly` stops
 * that, which is a strictly safer answer than the one it replaces.
 */
export function legacyModeOf(location: StorageLocationStateSource): StorageLocationMode | null {
  if (location.mode !== undefined) return null
  if (location.config[LEGACY_READ_ONLY_CONFIG_KEY] === true) return 'readonly'
  if (location.enabled === false) return 'readonly'
  return null
}

/**
 * The state of a location, stamped or folded. THE one interpretation: a row
 * that predates D385 is never ambiguous, and a stamped `mode` always wins over
 * whatever the legacy pair still says.
 */
export function resolveLocationMode(location: StorageLocationStateSource): StorageLocationMode {
  const stamped = isStorageLocationMode(location.mode) ? location.mode : undefined
  return stamped ?? legacyModeOf(location) ?? 'active'
}

/** Is this one of the four states? The stamped value crosses a wire, and a
 *  value nobody defined must not be rendered as if it were a state. */
export function isStorageLocationMode(value: unknown): value is StorageLocationMode {
  return STORAGE_LOCATION_MODES.some((mode) => mode === value)
}

/** May this location be written to? */
export function mayWriteToLocation(location: StorageLocationStateSource): boolean {
  return modeMayWrite(resolveLocationMode(location))
}

/** May this location be read? A `disabled` one may not — and that is an
 *  operator CHOICE, which callers must report as unavailable rather than as an
 *  unknown-location fault. */
export function mayReadLocation(location: StorageLocationStateSource): boolean {
  return modeMayRead(resolveLocationMode(location))
}

/** What eviction may do to this location. */
export function evictionPolicyOfLocation(
  location: StorageLocationStateSource,
): StorageEvictionPolicy {
  return evictionPolicyForMode(resolveLocationMode(location))
}

/**
 * The config blob with the retired drain key removed. Returns the SAME object
 * when there was nothing to strip, so a caller can tell "changed" from
 * "unchanged" by identity and skip a pointless persist.
 */
export function strippedOfLegacyReadOnly(
  config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!(LEGACY_READ_ONLY_CONFIG_KEY in config)) return config
  const next: Record<string, unknown> = { ...config }
  delete next[LEGACY_READ_ONLY_CONFIG_KEY]
  return next
}

/** The subset of a location row {@link withLocationMode} rewrites. */
export interface StorageLocationModePatch {
  readonly mode: StorageLocationMode
  readonly enabled: boolean
  readonly config: Readonly<Record<string, unknown>>
}

/**
 * Set a location's mode, and with it everything that must agree with it.
 *
 * `enabled` stays readable for one release as a DERIVED value (`mode ===
 * 'active'`) so consumers that have not moved yet keep working, and the legacy
 * `config.readOnly` key is DELETED. This function is the only way to write
 * either, which is what makes it impossible for the two to disagree.
 *
 * Returns a new object — the input is never mutated.
 */
export function withLocationMode<T extends StorageLocationStateSource>(
  location: T,
  mode: StorageLocationMode,
): T & StorageLocationModePatch {
  return {
    ...location,
    mode,
    enabled: modeMayWrite(mode),
    config: strippedOfLegacyReadOnly(location.config),
  }
}
