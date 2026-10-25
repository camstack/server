/**
 * A driver's device-settings form, kept on the keychain side of the wire
 * (D787 / D789 for device forms).
 *
 * A driver hydrates its own form from the config `loadConfig` RESOLVED for it,
 * so a camera password reaches the form as plaintext even though the stored
 * blob holds a keychain marker. This module closes that in ONE place — the
 * device-manager aggregate every device form goes through — for every driver:
 *
 *  - READ ({@link viewStoredSecrets}): a form field whose key names a stored
 *    MARKER (a declared `secretConfigPaths` entry, or a field secret by type)
 *    is handed the marker's VIEW instead of the driver's plaintext. A value
 *    that is still inline plaintext in the blob (not migrated) is left as the
 *    driver hydrated it: there is nothing to reveal it by.
 *  - WRITE ({@link applyDriverFormPatch}): the form sends the view back for an
 *    untouched field and `{ $secretClear: true }` for an explicit clear. The
 *    driver understands neither (its schema wants a string), so a view is
 *    dropped from the driver's patch (KEEP — the driver still holds the
 *    resolved value) and a clear reaches the driver as `''` while the stored
 *    marker is removed at the keychain door. A typed value passes through and
 *    the driver's own persist stores it in the keychain.
 *
 * Top-level keys only: a driver form's field key is its config key for every
 * declared device secret today (`password`, `apiKey`, `localKey`). A nested or
 * per-row path (`connection.password`, `rows[].pin`) is not mapped onto a form
 * field and keeps the driver's hydration.
 */
import {
  type ConfigFieldWithValue,
  isKeychainStoredField,
  isSecretClear,
  isSecretMarker,
  isSecretMarkerLike,
  toSecretFieldView,
} from '@camstack/types'
import type { ContributionShape } from './device-meta-types.js'

type Sections = ContributionShape['sections']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConfigFieldWithValue(field: unknown): field is ConfigFieldWithValue {
  if (!isRecord(field)) return false
  return typeof field.type === 'string' && typeof field.key === 'string' && 'value' in field
}

/** The declared paths that name a top-level config key. */
function topLevelKeys(paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths.filter((p) => p.length > 0 && !p.includes('.') && !p.includes('[')))
}

function viewField(
  field: unknown,
  stored: Record<string, unknown>,
  declared: ReadonlySet<string>,
): unknown {
  if (!isRecord(field)) return field
  const nested = field['fields']
  if (Array.isArray(nested)) {
    return { ...field, fields: nested.map((f) => viewField(f, stored, declared)) }
  }
  const tabs = field['tabs']
  if (Array.isArray(tabs)) {
    return {
      ...field,
      tabs: tabs.map((tab) =>
        isRecord(tab) && Array.isArray(tab['fields'])
          ? { ...tab, fields: tab['fields'].map((f) => viewField(f, stored, declared)) }
          : tab,
      ),
    }
  }
  if (!isConfigFieldWithValue(field)) return field
  const key = field.key
  const marker = stored[key]
  if (!isSecretMarker(marker)) return field
  // The form's field type is the driver's to choose; a declared secret drawn
  // as plain text becomes a password so the form renders the keychain view.
  const secretByType = isKeychainStoredField(field)
  if (!secretByType && !declared.has(key)) return field
  const type = secretByType ? field['type'] : 'password'
  return { ...field, type, value: toSecretFieldView(marker) }
}

/**
 * The driver's hydrated sections with every keychain-stored secret replaced
 * by its view. Returns the input unchanged when the blob holds no marker.
 */
export function viewStoredSecrets(
  sections: Sections,
  stored: Record<string, unknown>,
  declaredPaths: readonly string[],
): Sections {
  if (!Object.values(stored).some(isSecretMarker)) return sections
  const declared = topLevelKeys(declaredPaths)
  return sections.map((section) => ({
    ...section,
    fields: section.fields.map((f) => viewField(f, stored, declared)),
  }))
}

/** A form patch split into what the driver applies and what the door clears. */
export interface DriverFormPatch {
  readonly driverPatch: Record<string, unknown>
  readonly clearKeys: readonly string[]
}

/** Split a device-settings form patch (see the module doc). */
export function splitDriverFormPatch(patch: Record<string, unknown>): DriverFormPatch {
  const driverPatch: Record<string, unknown> = {}
  const clearKeys: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (isSecretClear(value)) {
      driverPatch[key] = ''
      clearKeys.push(key)
    } else if (!isSecretMarkerLike(value)) {
      driverPatch[key] = value
    }
  }
  return { driverPatch, clearKeys }
}

/**
 * Apply a device-settings form patch: the driver gets plain values only, then
 * an explicit clear removes the stored secret at the keychain door (after the
 * driver's own persist, whose `''` the door reads as KEEP).
 */
export async function applyDriverFormPatch(input: {
  readonly patch: Record<string, unknown>
  readonly applyToDriver: (driverPatch: Record<string, unknown>) => Promise<void>
  readonly clearSecrets: (keys: readonly string[]) => Promise<void>
}): Promise<void> {
  const { driverPatch, clearKeys } = splitDriverFormPatch(input.patch)
  if (Object.keys(driverPatch).length > 0) await input.applyToDriver(driverPatch)
  if (clearKeys.length > 0) await input.clearSecrets(clearKeys)
}
