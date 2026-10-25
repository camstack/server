/**
 * groupTopLevelAndAccessories — pure splitter for the DeviceList
 * row pipeline.
 *
 * Classification:
 *   - Top-level rows: standalone devices (`parentDeviceId === null`)
 *     plus adopted devices whose parent is a hub or NVR (e.g. cameras
 *     under a `Home hub`). Adopted devices keep their parent badge but
 *     render as primary rows + paginate.
 *   - Accessories: devices whose parent is a CAMERA (or any non-
 *     hub/nvr type). Render nested under the parent's chevron.
 *
 * Why parent-type and not the device's own `role`: the wire response
 * from `deviceManager.listAll` ships `role: null` even for siren /
 * floodlight / pir-sensor children — `device.role` is currently only
 * populated on the in-memory `IDevice` instance and is dropped during
 * `toDeviceInfo()` projection. Using parent-type gives the same answer
 * without depending on a field that's empty in practice. As a defensive
 * fallback we ALSO treat any row with a non-null `role` as an accessory
 * so a future wire fix doesn't accidentally re-flatten the table.
 *
 *   - Orphan accessories (parentDeviceId references a device not in
 *     the input list) fall through to topLevel — better to show them
 *     once with a stale parent badge than hide them entirely.
 *
 * Pure: no side effects, no React; testable as a unit.
 */
import type { DeviceItemDevice } from '../device-item/helpers'

/**
 * countableDevices — the subset of `devices` that should be counted in
 * the device-list footer "Showing N of **M** devices".
 *
 * A device is countable when:
 *   - it has no parent (`parentDeviceId === null`), OR
 *   - its parent's type is a hub-like owner (`hub` / `nvr`) — an NVR's
 *     cameras and a hub's children are real, individually-operable devices.
 *
 * Excluded:
 *   - devices whose parent has type `container` — a Container is a grouping
 *     shell for entity-children (e.g. a HA device's entities); the children
 *     are represented by the parent row and must NOT inflate the total.
 *   - orphan devices (parent id present but not in the input list) are
 *     treated as countable — better to over-count by one than hide them.
 *
 * Pure: builds a `Map<id, device>` once and then filters in a single pass.
 */
export function countableDevices(
  devices: readonly DeviceItemDevice[],
): readonly DeviceItemDevice[] {
  const byId = new Map<number, DeviceItemDevice>()
  for (const d of devices) byId.set(d.id, d)

  return devices.filter((d) => {
    if (d.parentDeviceId === null || d.parentDeviceId === undefined) return true
    const parent = byId.get(d.parentDeviceId)
    if (!parent) return true // orphan — show, don't silently drop
    return PARENT_AS_OWNER_TYPES.has(parent.type.toLowerCase())
  })
}

export interface GroupedDevices {
  readonly topLevel: readonly DeviceItemDevice[]
  readonly accessoriesByParent: ReadonlyMap<number, readonly DeviceItemDevice[]>
}

const PARENT_AS_OWNER_TYPES: ReadonlySet<string> = new Set(['hub', 'nvr'])

/** Options for `groupTopLevelAndAccessories`. */
export interface GroupDevicesOptions {
  /** Include devices carrying an operator `display.hidden` override. Default
   *  false — hidden devices are omitted from BOTH top-level and accessory
   *  lists. NOTE: distinct from the HA `accessories` cap `hiddenChildIds`
   *  mechanism (container-scoped, provider-persisted) — this is the device-level
   *  `display.hidden` flag. A future "show hidden" toggle flips this one prop. */
  readonly includeHidden?: boolean
}

/**
 * Re-order top-level rows so an ADOPTED device sits immediately after its
 * parent row (a camera adopted by a `Home hub` is a primary row by design,
 * but a primary row whose family is scattered across the table reads as a
 * bug — the operator saw a standalone camera WEDGED between a hub and its
 * two children). Pure and stable: parents/standalone keep their incoming
 * relative order, siblings keep theirs, and a child whose parent is not a
 * top-level row keeps its own position (emitted in the leftover pass —
 * never dropped).
 */
export function orderAdoptedAfterParent(
  rows: readonly DeviceItemDevice[],
): readonly DeviceItemDevice[] {
  const topIds = new Set(rows.map((d) => d.id))
  const childrenOf = new Map<number, DeviceItemDevice[]>()
  const roots: DeviceItemDevice[] = []
  for (const d of rows) {
    const parentId = d.parentDeviceId
    if (parentId !== null && parentId !== undefined && parentId !== d.id && topIds.has(parentId)) {
      const list = childrenOf.get(parentId)
      if (list) list.push(d)
      else childrenOf.set(parentId, [d])
      continue
    }
    roots.push(d)
  }
  const ordered: DeviceItemDevice[] = []
  const emitted = new Set<number>()
  const emit = (device: DeviceItemDevice): void => {
    if (emitted.has(device.id)) return
    emitted.add(device.id)
    ordered.push(device)
    const kids = childrenOf.get(device.id)
    if (kids) for (const kid of kids) emit(kid)
  }
  for (const root of roots) emit(root)
  // Leftovers: children whose parent chain never reached a root (a cycle or
  // a parent filtered upstream). Emit in incoming order rather than dropping.
  for (const d of rows) emit(d)
  return ordered
}

export function groupTopLevelAndAccessories(
  devices: readonly DeviceItemDevice[],
  options?: GroupDevicesOptions,
): GroupedDevices {
  const includeHidden = options?.includeHidden ?? false
  const byId = new Map<number, DeviceItemDevice>()
  for (const d of devices) byId.set(d.id, d)
  const topLevel: DeviceItemDevice[] = []
  const accessoriesByParent = new Map<number, DeviceItemDevice[]>()

  for (const d of devices) {
    if (!includeHidden && d.display?.hidden === true) continue
    const parentId = d.parentDeviceId
    if (parentId === null || parentId === undefined) {
      topLevel.push(d)
      continue
    }
    const parent = byId.get(parentId)
    if (!parent) {
      // Orphan — parent missing from the input list. Show at top-level
      // so the operator at least sees the device.
      topLevel.push(d)
      continue
    }
    // Adopted: parent is a hub/NVR and the child has no role override.
    // Cameras adopted by a `Home hub` keep their primary-row treatment.
    const hasRole = d.role !== null && d.role !== undefined
    const parentIsOwner = PARENT_AS_OWNER_TYPES.has(parent.type)
    if (parentIsOwner && !hasRole) {
      topLevel.push(d)
      continue
    }
    // Otherwise: accessory of a camera (or other non-hub parent). Group
    // under the parent so the table renders it as a nested row.
    const list = accessoriesByParent.get(parentId)
    if (list) list.push(d)
    else accessoriesByParent.set(parentId, [d])
  }

  return { topLevel: orderAdoptedAfterParent(topLevel), accessoriesByParent }
}
