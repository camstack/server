import type { DeviceNameFields } from '@camstack/ui-library'

/**
 * Physical (site) locations — rooms/areas devices belong to, not storage disks.
 *
 * Cameras, locks, sensors, and standalone accessories all get a room. A linked
 * accessory stays nested under its parent when they share a room (or the child
 * has no room of its own); if the child lives in a different room it is a
 * first-class row there.
 */

export interface SiteDevice {
  readonly id: number
  readonly name: string
  readonly location: string | null
  readonly type: string
  readonly isCamera: boolean
  readonly parentDeviceId: number | null
  readonly online: boolean
  readonly role?: string | null
  /**
   * Carried for the LINK REBUILD only, which resolves a container to its
   * primary child exactly as the hub does. Both are `slim` columns; dropping
   * them would make the button answer a different question from
   * `getLinkedDevices`, which is the one thing it must not do.
   */
  readonly stableId?: string
  readonly primaryChildEntityId?: string | null
}

export function siteDeviceFields(device: SiteDevice): DeviceNameFields {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    stableId: device.stableId ?? '',
    parentDeviceId: device.parentDeviceId,
    location: device.location,
    ...(device.role !== undefined && device.role !== null ? { role: device.role } : {}),
    ...(device.primaryChildEntityId !== undefined && device.primaryChildEntityId !== null
      ? { primaryChildEntityId: device.primaryChildEntityId }
      : {}),
  }
}

export interface SiteLocationGroup {
  readonly name: string
  readonly members: readonly SiteDevice[]
}

function locationKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed.toLowerCase()
}

export function devicesAtLocation(
  devices: readonly SiteDevice[],
  locationName: string,
): readonly SiteDevice[] {
  const key = locationKey(locationName)
  if (key === null) return []
  return devices.filter((d) => locationKey(d.location) === key)
}

/**
 * Devices that get their own row in a room card.
 *
 * Nested under a parent instead when that parent is also in this room — otherwise
 * a doorbell assigned to Front door would appear twice, once nested and once as
 * its own row.
 */
export function topLevelAtLocation(
  devices: readonly SiteDevice[],
  locationName: string,
): readonly SiteDevice[] {
  const here = devicesAtLocation(devices, locationName)
  const hereIds = new Set(here.map((d) => d.id))
  return here.filter((d) => d.parentDeviceId === null || !hereIds.has(d.parentDeviceId))
}

/**
 * The label this device carries that names NO registered room, or `null`.
 *
 * Prevents a device disappearing from the page entirely. `groupDevicesBySite`
 * only builds cards for REGISTERED names, so a device labelled with a room
 * that was deleted (or written by an import) sits in no card; under the old
 * `location === null` test for "unassigned" it sat in no list either. It was
 * work silently discarded. This is what the unassigned row shows instead.
 */
export function unregisteredLocationOf(
  device: SiteDevice,
  registeredNames: readonly string[],
): string | null {
  const key = locationKey(device.location)
  if (key === null) return null
  const registered = new Set(registeredNames.map((n) => locationKey(n)))
  return registered.has(key) ? null : (device.location?.trim() ?? null)
}

/**
 * Is this device in a room the operator can actually see on this page?
 *
 * "No room" and "a room that does not exist" are the same thing to an
 * operator: neither puts the device in a card. Treating only the first as
 * unassigned is what loses the second.
 */
function hasRegisteredRoom(device: SiteDevice, registered: ReadonlySet<string | null>): boolean {
  const key = locationKey(device.location)
  return key !== null && registered.has(key)
}

/**
 * Devices with no room — or a room that is not registered — except accessories
 * already nested under a parent that HAS a registered room.
 *
 * The nesting exception is not cosmetic: such an accessory is already visible
 * inside its parent's card, and the server cascade moves it with the parent.
 */
export function unassignedDevices(
  devices: readonly SiteDevice[],
  registeredNames: readonly string[],
): readonly SiteDevice[] {
  const registered = new Set(registeredNames.map((n) => locationKey(n)))
  const assignedIds = new Set(
    devices.filter((d) => hasRegisteredRoom(d, registered)).map((d) => d.id),
  )
  return devices.filter((d) => {
    if (hasRegisteredRoom(d, registered)) return false
    if (d.parentDeviceId !== null && assignedIds.has(d.parentDeviceId)) return false
    return true
  })
}

/**
 * The only rows the unassigned table renders: roomless devices that are nobody's
 * accessory.
 *
 * On the measured fleet this is 74 rows instead of 568 — 494 of the rest were
 * accessories whose parent is itself unassigned, and they follow that parent by
 * the `setLocation` cascade. Listing them would ask the operator to do 494 times
 * the work the server already does once.
 */
export function topLevelUnassigned(
  devices: readonly SiteDevice[],
  registeredNames: readonly string[],
): readonly SiteDevice[] {
  return unassignedDevices(devices, registeredNames).filter((d) => d.parentDeviceId === null)
}

/**
 * Every descendant of `rootId` in the device tree — the exact set the server's
 * `setLocation` cascade rewrites.
 *
 * BFS on `parentDeviceId` with a `visited` set, mirroring `collectDescendants`
 * in `device-meta-actions.ts`: unbounded in depth, and cycle-proof against
 * persisted data that points at itself. Deliberately TYPE-AGNOSTIC, unlike
 * `linkedChildren` (which drops cameras): the cascade does not check types, so
 * a count built on `linkedChildren` would under-report and the row would lie
 * about what a tap moves.
 */
export function descendantsOf(
  devices: readonly SiteDevice[],
  rootId: number,
): readonly SiteDevice[] {
  const byParent = new Map<number, SiteDevice[]>()
  for (const device of devices) {
    if (device.parentDeviceId === null) continue
    const siblings = byParent.get(device.parentDeviceId)
    if (siblings) siblings.push(device)
    else byParent.set(device.parentDeviceId, [device])
  }
  const out: SiteDevice[] = []
  const visited = new Set<number>([rootId])
  let frontier: number[] = [rootId]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const parentId of frontier) {
      for (const child of byParent.get(parentId) ?? []) {
        if (visited.has(child.id)) continue
        visited.add(child.id)
        out.push(child)
        next.push(child.id)
      }
    }
    frontier = next
  }
  return out
}

/**
 * How many other devices an assignment of `rootId` will move.
 *
 * This is the number the unassigned row shows BEFORE the tap. It must be
 * counted over the WHOLE fleet, never over a search-filtered slice: the cascade
 * ignores the operator's filter, and a smaller number here would understate it.
 */
export function cascadeFollowerCount(devices: readonly SiteDevice[], rootId: number): number {
  return descendantsOf(devices, rootId).length
}

export function linkedChildren(
  devices: readonly SiteDevice[],
  parentId: number,
): readonly SiteDevice[] {
  return devices.filter((d) => !d.isCamera && d.parentDeviceId === parentId)
}

export function groupDevicesBySite(
  devices: readonly SiteDevice[],
  registeredNames: readonly string[],
): readonly SiteLocationGroup[] {
  return registeredNames.map((name) => ({
    name,
    members: topLevelAtLocation(devices, name),
  }))
}
