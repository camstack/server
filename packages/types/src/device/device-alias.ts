/**
 * The device alias: the name a value template uses for a device
 * (`{{ stufa_veranda.temperature }}`), entity_id style.
 *
 * Generated ONCE from the device name when the device is first registered
 * (slugified, ascii, lowercase, `_`, deduped `_2`, `_3`), unique cluster-wide,
 * editable by the operator, and NOT changed when the device is renamed — a
 * template that names a device must not break because someone fixed a typo in
 * its label. At render time the alias resolves to the device (D1021).
 *
 * Pure: no store, no I/O. The device-manager owns the persistence and the
 * uniqueness check; this module owns the grammar.
 */
import { z } from 'zod'

export const DEVICE_ALIAS_MAX_LENGTH = 64

/** entity_id style: starts with a letter, then lowercase letters, digits and `_`. */
export const DEVICE_ALIAS_PATTERN = /^[a-z][a-z0-9_]*$/

/**
 * Words the template language gives a meaning to. An alias spelled like one
 * would read as the keyword, not as the device.
 */
const RESERVED_ALIASES: ReadonlySet<string> = new Set([
  'true',
  'false',
  'none',
  'null',
  'and',
  'or',
  'not',
  'in',
  'is',
  'if',
  'elif',
  'else',
  'endif',
  'for',
  'endfor',
  'loop',
  'set',
  'range',
  'cycler',
  'joiner',
  'self',
  'caller',
  'super',
  'import',
  'include',
  'extends',
  'block',
  'macro',
  'now',
])

export const DeviceAliasSchema = z.string().max(DEVICE_ALIAS_MAX_LENGTH).regex(DEVICE_ALIAS_PATTERN)

export type DeviceAliasRefusal = 'empty' | 'too-long' | 'grammar' | 'reserved' | 'taken'

export type DeviceAliasCheck =
  | { readonly ok: true; readonly alias: string }
  | { readonly ok: false; readonly reason: DeviceAliasRefusal }

export function isReservedDeviceAlias(alias: string): boolean {
  return RESERVED_ALIASES.has(alias)
}

/** A device name as an entity_id style identifier. Never empty, never digit-leading. */
export function slugifyDeviceAlias(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (slug.length === 0) return 'device'
  const led = /^[0-9]/.test(slug) ? `device_${slug}` : slug
  return led.slice(0, DEVICE_ALIAS_MAX_LENGTH - 4).replace(/_+$/g, '')
}

/**
 * The alias a new device gets: the slug of its name, or `<slug>_2`, `_3`, …
 * when that is taken (or is a template keyword).
 */
export function generateDeviceAlias(name: string, isTaken: (alias: string) => boolean): string {
  const base = slugifyDeviceAlias(name)
  if (!isReservedDeviceAlias(base) && !isTaken(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`
    if (!isTaken(candidate)) return candidate
  }
}

/** Validate an operator-typed alias. `isTaken` answers for every OTHER device. */
export function checkDeviceAlias(
  alias: string,
  isTaken: (alias: string) => boolean,
): DeviceAliasCheck {
  if (alias.length === 0) return { ok: false, reason: 'empty' }
  if (alias.length > DEVICE_ALIAS_MAX_LENGTH) return { ok: false, reason: 'too-long' }
  if (!DEVICE_ALIAS_PATTERN.test(alias)) return { ok: false, reason: 'grammar' }
  if (isReservedDeviceAlias(alias)) return { ok: false, reason: 'reserved' }
  if (isTaken(alias)) return { ok: false, reason: 'taken' }
  return { ok: true, alias }
}
