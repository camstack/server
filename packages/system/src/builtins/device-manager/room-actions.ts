/**
 * Rooms and site zones as records with an id (D1089).
 *
 * The entity methods (`ensureRoom`, `listRooms`, `updateRoom`, `deleteRoom`) are
 * the model: a rename, a new icon or a new description is ONE write to ONE
 * `rooms` record, and no device is rewritten (a device meta carries only
 * `locationId`; its `location` name is derived at read). A delete clears the
 * references in one operation.
 *
 * Everything else here — `listLocations`, `addLocation`, `removeLocation`,
 * `renameLocation`, the icon / description maps, the site-zone methods and
 * `setLocationZone` — is a thin SHIM over those, answering the same shapes as
 * before so the admin UI and the viewer keep working until they move to the ids.
 * A shim is removed once nothing calls it (D1089).
 */
import { randomUUID } from 'node:crypto'
import {
  entityNameKey,
  EventCategory,
  userError,
  type IDeviceManagerProvider,
  type IconKey,
  type Room,
  type RoomBody,
  type ZoneBody,
} from '@dominevo/types'
import type { Entity } from '../../records/named-entity-store.js'
import { EntityNameTakenError, EntityNotFoundError } from '../../records/named-entity-store.js'
import type { ProviderContext } from './device-provider-context.js'

type RoomEntity = Entity<RoomBody>

/** Room record → the wire shape. */
function toRoom(entity: RoomEntity): Room {
  return entity
}

function requireName(name: string, code: string, what: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw userError(code, undefined, `[device-manager] ${what}: name must be non-empty`)
  }
  return trimmed
}

/** Drop a field when the patch says `null`, keep it when absent, set it otherwise. */
function applied<T>(patch: T | null | undefined, current: T | undefined): T | undefined {
  if (patch === undefined) return current
  if (patch === null) return undefined
  return patch
}

function emitLocationChanged(pctx: ProviderContext, deviceId: number, value: string | null): void {
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'location', value },
  })
}

/** The ids of every device whose room is `roomId`. */
async function devicesInRoom(pctx: ProviderContext, roomId: string): Promise<readonly number[]> {
  const rows = await pctx.metaStore.rows.listAll()
  return rows.filter((row) => row.meta.locationId === roomId).map((row) => row.meta.id)
}

// ── Entity methods ───────────────────────────────────────────────────────

export async function ensureRoom(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['ensureRoom']>[0],
): ReturnType<IDeviceManagerProvider['ensureRoom']> {
  const name = requireName(input.name, 'system.location-name-required', 'ensureRoom')
  return toRoom(await pctx.rooms.rooms.ensure(name, {}))
}

export async function listRooms(
  pctx: ProviderContext,
): ReturnType<IDeviceManagerProvider['listRooms']> {
  return pctx.rooms.rooms.list().map(toRoom)
}

export async function updateRoom(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['updateRoom']>[0],
): ReturnType<IDeviceManagerProvider['updateRoom']> {
  const { id, patch } = input
  const before = pctx.rooms.rooms.get(id)
  let updated: RoomEntity
  try {
    updated = await pctx.rooms.rooms.update(id, (current) => {
      const next: RoomBody = {
        name: patch.name ?? current.name,
        icon: applied(patch.icon, current.icon),
        description: applied(patch.description, current.description),
        zoneId: applied(patch.zoneId, current.zoneId),
        colour: applied(patch.colour, current.colour),
        order: applied(patch.order, current.order),
      }
      return next
    })
  } catch (err) {
    if (err instanceof EntityNotFoundError) {
      throw userError('system.room-not-found', undefined, `[device-manager] room not found: ${id}`)
    }
    if (err instanceof EntityNameTakenError) {
      throw userError('system.room-name-taken', undefined, `[device-manager] ${err.message}`)
    }
    throw err
  }
  // A rename is ONE record write. Surfaces that cache the derived name are told,
  // as an event (telemetry) — nothing is rewritten.
  if (before !== null && before.name !== updated.name) {
    for (const deviceId of await devicesInRoom(pctx, id)) {
      emitLocationChanged(pctx, deviceId, updated.name)
    }
  }
  return toRoom(updated)
}

export async function deleteRoom(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['deleteRoom']>[0],
): ReturnType<IDeviceManagerProvider['deleteRoom']> {
  const existed = await pctx.rooms.rooms.delete(input.id)
  if (!existed) return { cleared: 0 }
  // The record is gone first: a device still carrying the id reads as unset from
  // here on, so a crash before the clear below leaves nothing visible behind.
  const cleared = await pctx.metaStore.withMetaWriteLock(async () => {
    const out: number[] = []
    for (const row of await pctx.metaStore.rows.listAll()) {
      if (row.meta.locationId !== input.id) continue
      await pctx.metaStore.rows.patch(row.meta.id, { locationId: null })
      out.push(row.meta.id)
    }
    return out
  })
  for (const deviceId of cleared) emitLocationChanged(pctx, deviceId, null)
  return { cleared: cleared.length }
}

/**
 * The id a write names: `locationId` wins, else `location` (text) is resolved
 * through `ensureRoom`. `undefined` = the caller named neither, `null` = clear.
 */
export async function resolveRoomId(
  pctx: ProviderContext,
  input: { readonly location?: string | null; readonly locationId?: string | null },
): Promise<string | null | undefined> {
  if (input.locationId !== undefined) {
    if (input.locationId !== null && pctx.rooms.rooms.get(input.locationId) === null) {
      throw userError(
        'system.room-not-found',
        undefined,
        `[device-manager] room not found: ${input.locationId}`,
      )
    }
    return input.locationId
  }
  if (input.location === undefined) return undefined
  if (input.location === null || input.location.trim().length === 0) return null
  return (await pctx.rooms.rooms.ensure(input.location.trim(), {})).id
}

// ── Shims over the entity methods ────────────────────────────────────────

export async function listLocations(
  pctx: ProviderContext,
): ReturnType<IDeviceManagerProvider['listLocations']> {
  return pctx.rooms.rooms
    .list()
    .map((room) => room.name)
    .toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

export async function addLocation(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['addLocation']>[0],
): ReturnType<IDeviceManagerProvider['addLocation']> {
  const name = requireName(input.name, 'system.location-name-required', 'addLocation')
  await pctx.rooms.rooms.ensure(name, {})
}

export async function removeLocation(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['removeLocation']>[0],
): ReturnType<IDeviceManagerProvider['removeLocation']> {
  const room = pctx.rooms.rooms.findByName(input.name)
  if (room === null) return
  // `cascade` clears the devices' room (D1089: a delete always clears the
  // references). Without it the room is a suggestion list entry a device still
  // uses: it stays while any device carries it (its icon, description and zone cleared)
  // and goes only when none does.
  if (input.cascade === true) {
    await deleteRoom(pctx, { id: room.id })
    return
  }
  if ((await devicesInRoom(pctx, room.id)).length > 0) {
    // Its devices still use the room, so the record stays; what a registry entry carried
    // (icon, description, zone) goes, as it always did.
    await updateRoom(pctx, {
      id: room.id,
      patch: { icon: null, description: null, zoneId: null },
    })
    return
  }
  await pctx.rooms.rooms.delete(room.id)
}

export async function renameLocation(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['renameLocation']>[0],
): ReturnType<IDeviceManagerProvider['renameLocation']> {
  const from = requireName(input.from, 'system.location-name-required', 'renameLocation')
  const to = requireName(input.to, 'system.location-name-required', 'renameLocation')
  const source = pctx.rooms.rooms.findByName(from)
  if (source === null) return { moved: 0 }
  const target = pctx.rooms.rooms.findByName(to)
  if (target === null || target.id === source.id) {
    // The plain rename — and a case-only one: ONE record, no device touched.
    await updateRoom(pctx, { id: source.id, patch: { name: to } })
    return { moved: (await devicesInRoom(pctx, source.id)).length }
  }
  // A MERGE: the devices move into the room that exists, which keeps its own
  // icon, description and zone; the source room goes.
  const moved = await pctx.metaStore.withMetaWriteLock(async () => {
    const out: number[] = []
    for (const row of await pctx.metaStore.rows.listAll()) {
      if (row.meta.locationId !== source.id) continue
      await pctx.metaStore.rows.patch(row.meta.id, { locationId: target.id })
      out.push(row.meta.id)
    }
    return out
  })
  await pctx.rooms.rooms.delete(source.id)
  for (const deviceId of moved) emitLocationChanged(pctx, deviceId, target.name)
  return { moved: moved.length }
}

export async function listLocationIcons(
  pctx: ProviderContext,
): ReturnType<IDeviceManagerProvider['listLocationIcons']> {
  return pctx.rooms.rooms
    .list()
    .flatMap((room) =>
      room.icon === undefined ? [] : [{ locationKey: entityNameKey(room.name), icon: room.icon }],
    )
    .toSorted((a, b) => a.locationKey.localeCompare(b.locationKey))
}

export async function setLocationIcon(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setLocationIcon']>[0],
): ReturnType<IDeviceManagerProvider['setLocationIcon']> {
  const name = requireName(input.location, 'system.location-required', 'setLocationIcon')
  const existing = pctx.rooms.rooms.findByName(name)
  if (existing === null && input.icon === null) return
  const room = existing ?? (await pctx.rooms.rooms.ensure(name, {}))
  const icon: IconKey | null = input.icon
  await updateRoom(pctx, { id: room.id, patch: { icon } })
}

export async function listLocationDescriptions(
  pctx: ProviderContext,
): ReturnType<IDeviceManagerProvider['listLocationDescriptions']> {
  return pctx.rooms.rooms
    .list()
    .flatMap((room) =>
      room.description === undefined
        ? []
        : [{ locationKey: entityNameKey(room.name), description: room.description }],
    )
    .toSorted((a, b) => a.locationKey.localeCompare(b.locationKey))
}

export async function setLocationDescription(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setLocationDescription']>[0],
): ReturnType<IDeviceManagerProvider['setLocationDescription']> {
  const name = requireName(input.location, 'system.location-required', 'setLocationDescription')
  // A BLANK description clears, exactly as `null` does.
  const text = input.description === null ? '' : input.description.trim()
  const existing = pctx.rooms.rooms.findByName(name)
  if (existing === null && text.length === 0) return
  const room = existing ?? (await pctx.rooms.rooms.ensure(name, {}))
  await updateRoom(pctx, {
    id: room.id,
    patch: { description: text.length === 0 ? null : text },
  })
}

// ── Site zones ───────────────────────────────────────────────────────────

type ZoneEntity = Entity<ZoneBody>

function zoneFolded(zone: ZoneEntity): string {
  return entityNameKey(zone.name)
}

export async function listSiteZones(
  pctx: ProviderContext,
): ReturnType<IDeviceManagerProvider['listSiteZones']> {
  const rooms = pctx.rooms.rooms.list()
  return pctx.rooms.zones
    .list()
    .map((zone) => ({
      zoneKey: zoneFolded(zone),
      label: zone.name,
      icon: zone.icon ?? null,
      locationKeys: rooms
        .filter((room) => room.zoneId === zone.id)
        .map((room) => entityNameKey(room.name))
        .toSorted((a, b) => a.localeCompare(b)),
    }))
    .toSorted((a, b) => a.zoneKey.localeCompare(b.zoneKey))
}

export async function setSiteZone(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setSiteZone']>[0],
): ReturnType<IDeviceManagerProvider['setSiteZone']> {
  const label = requireName(input.name, 'system.site-zone-name-required', 'setSiteZone')
  const zone = await pctx.rooms.zones.ensure(label, {})
  // `icon` OMITTED keeps the icon; `null` clears it and KEEPS the zone. The
  // label is re-stamped as typed (a case-only change re-labels, never duplicates).
  await pctx.rooms.zones.update(zone.id, (current) => {
    const next: ZoneBody = { name: label }
    const icon =
      input.icon === undefined ? current.icon : input.icon === null ? undefined : input.icon
    if (icon !== undefined) next.icon = icon
    return next
  })
}

/** Clear `zoneId` on every room that names `zoneId`; one record write per room. */
async function detachRooms(
  pctx: ProviderContext,
  zoneId: string,
  to: string | null,
): Promise<void> {
  for (const room of pctx.rooms.rooms.list()) {
    if (room.zoneId !== zoneId) continue
    await updateRoom(pctx, { id: room.id, patch: { zoneId: to } })
  }
}

export async function removeSiteZone(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['removeSiteZone']>[0],
): ReturnType<IDeviceManagerProvider['removeSiteZone']> {
  const zone = pctx.rooms.zones.findByName(input.name)
  if (zone === null) return
  // Its rooms survive, unattached: deleting a grouping never deletes what was grouped.
  await detachRooms(pctx, zone.id, null)
  await pctx.rooms.zones.delete(zone.id)
}

export async function renameSiteZone(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['renameSiteZone']>[0],
): ReturnType<IDeviceManagerProvider['renameSiteZone']> {
  const to = requireName(input.to, 'system.site-zone-name-required', 'renameSiteZone')
  const source = pctx.rooms.zones.findByName(input.from)
  if (source === null) return
  const target = pctx.rooms.zones.findByName(to)
  if (target === null || target.id === source.id) {
    await pctx.rooms.zones.update(source.id, (current) => ({ ...current, name: to }))
    return
  }
  // A MERGE: the target keeps its own icon, the rooms are unioned into it.
  await detachRooms(pctx, source.id, target.id)
  await pctx.rooms.zones.delete(source.id)
}

export async function setLocationZone(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setLocationZone']>[0],
): ReturnType<IDeviceManagerProvider['setLocationZone']> {
  const name = requireName(input.location, 'system.location-required', 'setLocationZone')
  if (input.zone === null) {
    const existing = pctx.rooms.rooms.findByName(name)
    if (existing === null || existing.zoneId === undefined) return
    await updateRoom(pctx, { id: existing.id, patch: { zoneId: null } })
    return
  }
  const zoneName = requireName(input.zone, 'system.site-zone-name-required', 'setLocationZone')
  // The zone is created if it does not exist; so is the room (no registration first).
  const zone = await pctx.rooms.zones.ensure(zoneName, {})
  const room = await pctx.rooms.rooms.ensure(name, {})
  if (room.zoneId === zone.id) return
  await updateRoom(pctx, { id: room.id, patch: { zoneId: zone.id } })
}
