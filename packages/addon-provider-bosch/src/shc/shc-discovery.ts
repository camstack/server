import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import { capsForShcKind, classifyShcDevice, deviceTypeForShcKind } from './shc-domain-mapping.js'
import type { ShcDeviceKind, ShcDeviceSummary } from './shc-types.js'

const GATEWAY_SUFFIX = ':controller'

/** The `childNativeId` (and `shcDeviceId`) of the controller box itself, one per integration. */
export function shcGatewayNativeId(integrationId: string): string {
  return `${integrationId}${GATEWAY_SUFFIX}`
}

export interface BuildShcCandidatesInput {
  readonly integrationId: string
  readonly integrationName: string
  readonly devices: readonly ShcDeviceSummary[]
  /** shcDeviceId → adopted CamStack device id. */
  readonly adopted: ReadonlyMap<string, number>
}

function shouldSkipShcDevice(device: ShcDeviceSummary): boolean {
  if (classifyShcDevice(device) === 'unsupported') return true
  if (device.deviceModel.startsWith('HOMECONNECT_')) return true
  if (device.services.includes('HCDishwasher')) return true
  return false
}

function collectTrvsLinkedToRoomClimate(devices: readonly ShcDeviceSummary[]): ReadonlySet<string> {
  const roomClimateIds = new Set<string>()
  for (const device of devices) {
    if (classifyShcDevice(device) === 'room-climate') {
      roomClimateIds.add(device.id)
    }
  }
  const linked = new Set<string>()
  for (const device of devices) {
    if (classifyShcDevice(device) !== 'room-climate') continue
    for (const childId of device.childDeviceIds ?? []) {
      linked.add(childId)
    }
  }
  for (const device of devices) {
    const parent = device.parentDeviceId
    if (parent !== undefined && roomClimateIds.has(parent)) {
      linked.add(device.id)
    }
  }
  return linked
}

function trvCandidate(device: ShcDeviceSummary): DiscoveredChildDevice {
  return {
    childNativeId: device.id,
    name: device.name.length > 0 ? device.name : device.id,
    type: DeviceType.Thermostat,
    status: 'online',
    metadata: {
      serialNumber: device.id,
      model: device.deviceModel,
    },
    alreadyAdopted: false,
    adoptedDeviceId: null,
    capabilities: [...capsForShcKind('trv')],
  }
}

/** Climate accessory label: `Climate` plus the room name. */
export function shcClimateEntityName(roomName: string): string {
  const room = roomName.trim()
  return room.length > 0 ? `Climate ${room}` : 'Climate'
}

function roomClimateContainerCandidate(
  device: ShcDeviceSummary,
  devices: readonly ShcDeviceSummary[],
  adoptedId: number | null,
): DiscoveredChildDevice {
  const byId = new Map(devices.map((d) => [d.id, d]))
  const climateChild: DiscoveredChildDevice = {
    childNativeId: `${device.id}#climate`,
    name: shcClimateEntityName(device.name.length > 0 ? device.name : device.id),
    type: DeviceType.Climate,
    status: 'online',
    metadata: { serialNumber: device.id, model: device.deviceModel },
    alreadyAdopted: false,
    adoptedDeviceId: null,
    capabilities: ['climate-control'],
  }
  const trvChildren: DiscoveredChildDevice[] = []
  for (const trvId of device.childDeviceIds ?? []) {
    const trv = byId.get(trvId)
    if (trv === undefined || classifyShcDevice(trv) !== 'trv') continue
    trvChildren.push(trvCandidate(trv))
  }
  return {
    childNativeId: device.id,
    name: device.name.length > 0 ? device.name : device.id,
    type: DeviceType.Container,
    status: 'online',
    metadata: {
      serialNumber: device.id,
      model: device.deviceModel,
    },
    alreadyAdopted: adoptedId !== null,
    adoptedDeviceId: adoptedId,
    capabilities: [],
    children: [climateChild, ...trvChildren],
  }
}

function leafCandidate(
  device: ShcDeviceSummary,
  kind: Exclude<ShcDeviceKind, 'unsupported' | 'room-climate'>,
  adoptedId: number | null,
): DiscoveredChildDevice {
  return {
    childNativeId: device.id,
    name: device.name.length > 0 ? device.name : device.id,
    type: deviceTypeForShcKind(kind),
    status: 'online',
    metadata: {
      serialNumber: device.id,
      model: device.deviceModel,
    },
    alreadyAdopted: adoptedId !== null,
    adoptedDeviceId: adoptedId,
    capabilities: [...capsForShcKind(kind)],
  }
}

/** Map live SHC discovery rows to adoption candidates. Pure — no I/O. */
export function buildShcCandidates(input: BuildShcCandidatesInput): DiscoveredChildDevice[] {
  const linkedTrvs = collectTrvsLinkedToRoomClimate(input.devices)
  const gatewayId = shcGatewayNativeId(input.integrationId)
  const gatewayAdopted = input.adopted.get(gatewayId) ?? null
  // A sibling of the rooms and devices, never their parent. The SHC API offers no
  // reboot or update and the controller has no web page, so it carries no actions.
  const out: DiscoveredChildDevice[] = [
    {
      childNativeId: gatewayId,
      name: input.integrationName,
      type: DeviceType.Gateway,
      status: 'online',
      metadata: { manufacturer: 'Bosch', model: 'Smart Home Controller' },
      alreadyAdopted: gatewayAdopted !== null,
      adoptedDeviceId: gatewayAdopted,
      capabilities: [],
    },
  ]
  for (const device of input.devices) {
    if (shouldSkipShcDevice(device)) continue
    const kind = classifyShcDevice(device)
    if (kind === 'unsupported') continue
    const adoptedId = input.adopted.get(device.id) ?? null
    if (kind === 'room-climate') {
      out.push(roomClimateContainerCandidate(device, input.devices, adoptedId))
      continue
    }
    if (kind === 'trv' && linkedTrvs.has(device.id)) continue
    if (kind === 'trv') {
      out.push({
        ...trvCandidate(device),
        alreadyAdopted: adoptedId !== null,
        adoptedDeviceId: adoptedId,
      })
      continue
    }
    out.push(leafCandidate(device, kind, adoptedId))
  }
  return out
}
