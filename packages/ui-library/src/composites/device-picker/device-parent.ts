/**
 * A device's CONTAINER / hub name, resolved from a fleet listing.
 *
 * Pickers list devices by name, and on a real fleet that is not enough:
 * many sensors share a name ("Temperatura"). The container is what tells
 * them apart, and `parentDeviceId` already rides the slim projection —
 * so this costs no query, only the lookup.
 *
 * ONE level, deliberately: the operator's question is "which thing is this
 * attached to", not "what is the full ancestry".
 */
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text'

/** The fields this needs. Any listing row satisfies it. */
export interface ParentResolvable {
  readonly id: number
  readonly name: string
  readonly parentDeviceId: number | null
}

/**
 * Map of `deviceId → container label`, absent for a top-level device.
 *
 * A parent that is NOT in the listing resolves to `#<id>` rather than to
 * nothing: the listing can be filtered or partial, and rendering nothing would
 * say "this is top-level", which is a different claim and a wrong one.
 */
export function resolveParentNames(
  devices: readonly ParentResolvable[],
): ReadonlyMap<number, string> {
  const byId = new Map<number, string>()
  for (const d of devices) byId.set(d.id, d.name)

  const out = new Map<number, string>()
  for (const d of devices) {
    const parent = d.parentDeviceId
    if (parent === null) continue
    // A row that is its own parent is corrupt data, not a container.
    if (parent === d.id) continue
    out.set(d.id, byId.get(parent) ?? `#${String(parent)}`)
  }
  return out
}

/** Second-line hint: `in <parent>` when the device lives under a hub/container. */
export function parentDetailOf(
  parentName: string | undefined,
  t: UiTextFn = defaultUiText,
): string | undefined {
  if (parentName === undefined || parentName.length === 0) return undefined
  return t('uiLibrary.devicePicker.parentDetail', 'in {{parent}}', { parent: parentName })
}

/**
 * Fill unset `detail` with `in <parent>` from {@link parentDeviceId} on the
 * same list. Callers that already set `detail` keep it. String-id pickers
 * (nodes, packages) are returned unchanged.
 */
export function withResolvedParentDetail<
  T extends {
    readonly id: number | string
    readonly name: string
    readonly detail?: string
    readonly parentDeviceId?: number | null
  },
>(devices: readonly T[]): readonly T[] {
  const numeric = devices.filter((d): d is T & { readonly id: number } => typeof d.id === 'number')
  if (numeric.length === 0) return devices
  const parents = resolveParentNames(
    numeric.map((d) => ({
      id: d.id,
      name: d.name,
      parentDeviceId: d.parentDeviceId ?? null,
    })),
  )
  let changed = false
  const next = devices.map((d) => {
    if (d.detail !== undefined || typeof d.id !== 'number') return d
    const detail = parentDetailOf(parents.get(d.id))
    if (detail === undefined) return d
    changed = true
    return { ...d, detail }
  })
  return changed ? next : devices
}
