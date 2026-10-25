/**
 * What a camera's Analytics form SHOWS for a field this camera never saved.
 *
 * The runtime resolves every per-device analytics setting from
 * `{ ...globalRaw, ...deviceRaw }` (`readDeviceSettings`): the cluster value
 * stands until the camera writes its own. The form used to hydrate from
 * `deviceRaw` alone, so a never-saved field rendered the SCHEMA default — a
 * number the runtime was not using whenever the cluster had set its own. An
 * operator who read "5" there and saved another field changed nothing, but had
 * every reason to believe the camera ran at 5.
 *
 * Two rules, both pinned by `inherited-device-values.spec.ts`:
 *   - the displayed value is the EFFECTIVE one (`{ ...globalRaw, ...deviceRaw }`),
 *     the same merge the resolvers use;
 *   - a field showing the cluster value says so in its description, and the
 *     form still saves only what the operator edits, so showing an inherited
 *     value never freezes it onto the camera.
 */
import {
  type ConfigFieldWithValue,
  type ConfigSectionWithValues,
  type ConfigUISchema,
  hydrateSchema,
} from '@camstack/types'

/** Appended to the description of a field whose value comes from the cluster. */
export const INHERITED_FROM_GLOBAL_NOTE =
  'Shown value is the cluster-wide setting. Change it here to override it for this camera only.'

function hasOwn(bag: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(bag, key)
}

function markInherited(
  field: ConfigFieldWithValue,
  globalRaw: Readonly<Record<string, unknown>>,
  deviceRaw: Readonly<Record<string, unknown>>,
): ConfigFieldWithValue {
  if (field.type === 'group') {
    return { ...field, fields: field.fields.map((f) => markInherited(f, globalRaw, deviceRaw)) }
  }
  if (field.type === 'sub-tabs') {
    return {
      ...field,
      tabs: field.tabs.map((tab) => ({
        ...tab,
        fields: tab.fields.map((f) => markInherited(f, globalRaw, deviceRaw)),
      })),
    }
  }
  // A field with no value slot (info, separator, button, widget) has nothing to
  // inherit and no description to extend.
  if (!('value' in field)) return field
  if (!hasOwn(globalRaw, field.key) || hasOwn(deviceRaw, field.key)) return field
  const description =
    field.description === undefined
      ? INHERITED_FROM_GLOBAL_NOTE
      : `${field.description} ${INHERITED_FROM_GLOBAL_NOTE}`
  return { ...field, description }
}

/**
 * Hydrate per-camera sections with the effective value of each field.
 *
 * @param schema     the per-device schema (global schema, already re-tabbed)
 * @param deviceRaw  the camera's own blob — only what it saved
 * @param globalRaw  the cluster store
 */
export function hydrateWithInheritedGlobals(
  schema: ConfigUISchema,
  deviceRaw: Readonly<Record<string, unknown>>,
  globalRaw: Readonly<Record<string, unknown>>,
): ConfigSectionWithValues[] {
  const hydrated = hydrateSchema(schema, { ...globalRaw, ...deviceRaw })
  return hydrated.sections.map((section) => ({
    ...section,
    fields: section.fields.map((f) => markInherited(f, globalRaw, deviceRaw)),
  }))
}
