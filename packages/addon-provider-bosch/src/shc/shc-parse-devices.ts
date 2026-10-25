import type { ShcDeviceSummary, ShcRawDevice, ShcRoomSummary } from './shc-types.js'

function serviceIdsFromRaw(device: ShcRawDevice): string[] {
  const fromIds = (device.deviceServiceIds ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  const fromData = (device.deviceServiceData ?? [])
    .map((s) => s.id ?? s.serviceType)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set([...fromIds, ...fromData])]
}

/** Bosch fills virtual devices with `-RoomClimateControl-` instead of a name. */
export function isPlaceholderShcName(name: string): boolean {
  return name.length > 2 && name.startsWith('-') && name.endsWith('-')
}

export function nameShcDevices(
  devices: readonly ShcDeviceSummary[],
  rooms: readonly { readonly id: string; readonly name: string }[],
): ShcDeviceSummary[] {
  const roomName = new Map(rooms.map((room) => [room.id, room.name.trim()]))
  return devices.map((device) => {
    if (!isPlaceholderShcName(device.name)) return device
    const fromRoom = device.roomId !== undefined ? roomName.get(device.roomId) : undefined
    if (fromRoom === undefined || fromRoom.length === 0) return device
    return { ...device, name: fromRoom }
  })
}

/** Normalise the GET /devices payload into {@link ShcDeviceSummary} rows. */
export function parseShcDeviceList(payload: unknown): ShcDeviceSummary[] {
  // The controller returns a bare array; some docs wrap it as `{ devices: [...] }`.
  const devicesRaw = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object'
      ? Reflect.get(payload, 'devices')
      : undefined
  if (!Array.isArray(devicesRaw)) return []

  const out: ShcDeviceSummary[] = []
  for (const row of devicesRaw) {
    if (row === null || typeof row !== 'object') continue
    const device = row as ShcRawDevice
    const id = device.id
    if (typeof id !== 'string' || id.length === 0) continue
    const deviceModel = typeof device.deviceModel === 'string' ? device.deviceModel : 'UNKNOWN'
    const name = typeof device.name === 'string' ? device.name : id
    const roomId = typeof device.roomId === 'string' ? device.roomId : undefined
    const childDeviceIds = Array.isArray(device.childDeviceIds)
      ? device.childDeviceIds.filter(
          (cid): cid is string => typeof cid === 'string' && cid.length > 0,
        )
      : undefined
    const parentDeviceId =
      typeof device.parentDeviceId === 'string' && device.parentDeviceId.length > 0
        ? device.parentDeviceId
        : undefined
    out.push({
      id,
      deviceModel,
      name,
      services: serviceIdsFromRaw(device),
      roomId,
      ...(childDeviceIds !== undefined && childDeviceIds.length > 0 ? { childDeviceIds } : {}),
      ...(parentDeviceId !== undefined ? { parentDeviceId } : {}),
    })
  }
  return out
}

export function parseShcRoomList(payload: unknown): ShcRoomSummary[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object'
      ? Reflect.get(payload, 'rooms')
      : undefined
  if (!Array.isArray(rows)) return []
  const out: ShcRoomSummary[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = Reflect.get(row, 'id')
    const name = Reflect.get(row, 'name')
    if (typeof id !== 'string' || id.length === 0) continue
    if (typeof name !== 'string' || name.trim().length === 0) continue
    out.push({ id, name: name.trim() })
  }
  return out
}
