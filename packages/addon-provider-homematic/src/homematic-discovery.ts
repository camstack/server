import type { HmDevice } from 'nodehomematic'
import { DeviceType, type DiscoveredChildDevice, deviceAdminLinkCapability } from '@camstack/types'
import { inferHmDeviceType, mapHmDeviceChannels } from './homematic-mapping.js'
import { deriveHmEntityPreviews } from './homematic-entity-derive.js'

const GATEWAY_SUFFIX = ':gateway'
const DEVICE_INFIX = ':device:'
const ENTITY_INFIX = ':entity:'

/** The `childNativeId` of the CCU box itself, one per integration. */
export function gatewayNativeId(integrationId: string): string {
  return `${integrationId}${GATEWAY_SUFFIX}`
}

/**
 * The `childNativeId` of a whole CCU device (adopted as a Container). The CCU
 * address is stable across reboots; it is namespaced under the integration so
 * two CCUs exposing the same address never collide.
 */
export function deviceNativeId(integrationId: string, hmAddress: string): string {
  return `${integrationId}${DEVICE_INFIX}${hmAddress}`
}

/** The `childNativeId` of one entity of a CCU device (adopted as a standalone device). */
export function entityNativeId(integrationId: string, hmAddress: string, key: string): string {
  return `${integrationId}${ENTITY_INFIX}${hmAddress}#${key}`
}

/** What a native id points at on the integration. */
export type ParsedNativeId =
  | { readonly kind: 'gateway' }
  | { readonly kind: 'device'; readonly hmAddress: string }
  | { readonly kind: 'entity'; readonly hmAddress: string; readonly key: string }

/** Parse a native id of `integrationId`, or null when it is not one of its ids or is malformed. */
export function parseNativeId(integrationId: string, nativeId: string): ParsedNativeId | null {
  if (nativeId === gatewayNativeId(integrationId)) return { kind: 'gateway' }
  const devicePrefix = `${integrationId}${DEVICE_INFIX}`
  if (nativeId.startsWith(devicePrefix)) {
    const hmAddress = nativeId.slice(devicePrefix.length)
    return hmAddress.length > 0 ? { kind: 'device', hmAddress } : null
  }
  const entityPrefix = `${integrationId}${ENTITY_INFIX}`
  if (nativeId.startsWith(entityPrefix)) {
    const rest = nativeId.slice(entityPrefix.length)
    const hash = rest.indexOf('#')
    if (hash <= 0 || hash === rest.length - 1) return null
    return { kind: 'entity', hmAddress: rest.slice(0, hash), key: rest.slice(hash + 1) }
  }
  return null
}

/** Inputs for {@link buildCcuGatewayCandidate}. */
export interface BuildCcuGatewayCandidateInput {
  readonly integrationId: string
  readonly integrationName: string
  /** Whether the CCU session is up (drives the candidate's status). */
  readonly online: boolean
  /** Native id -> adopted CamStack device id, for the devices already adopted. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * The CCU box as an adoption candidate ({@link DeviceType.Gateway}). It offers
 * only what the library really supports on a CCU: the link to its WebUI. There
 * is no reboot and no firmware update for the box (the library's firmware call
 * installs an update on a radio DEVICE by its address, not on the CCU).
 */
export function buildCcuGatewayCandidate(
  input: BuildCcuGatewayCandidateInput,
): DiscoveredChildDevice {
  const nativeId = gatewayNativeId(input.integrationId)
  const adoptedId = input.adopted.get(nativeId) ?? null
  return {
    childNativeId: nativeId,
    name: input.integrationName,
    type: DeviceType.Gateway,
    status: input.online ? 'online' : 'offline',
    metadata: { manufacturer: 'eQ-3', model: 'CCU3 / RaspberryMatic' },
    alreadyAdopted: adoptedId !== null,
    adoptedDeviceId: adoptedId,
    capabilities: [deviceAdminLinkCapability.name],
  }
}

/**
 * Minimal structural subset of `HmDevice` required by this module. Using a
 * `Pick` keeps the function signature tight while remaining structurally
 * compatible with both live `HmDevice` instances and test fixtures that
 * supply the same fields — no cast needed at the call site.
 *
 * `type` carries the CCU device-type string (e.g. `'HmIP-BSM'`), which is
 * the closest model identifier available on the wire and is surfaced in
 * `metadata.model` for the adoption panel.
 *
 * `rooms` carries the CCU room assignment(s) (populated only when WebUI
 * credentials are configured on the integration); the first entry is surfaced in
 * `metadata.externalLocation` so the adoption flow can import it as a
 * CamStack location.
 *
 * The firmware fields (`firmware` / `availableFirmware` / `updatable` /
 * `firmwareUpdateState`) are included so the per-entity preview can derive a
 * firmware-update child via `mapFirmwareUpdate`.
 */
export type HmDiscoverable = Pick<
  HmDevice,
  | 'address'
  | 'name'
  | 'type'
  | 'channels'
  | 'rooms'
  | 'firmware'
  | 'availableFirmware'
  | 'updatable'
  | 'firmwareUpdateState'
>

export interface BuildHmCandidatesInput {
  readonly integrationId: string
  readonly devices: readonly HmDiscoverable[]
  /** Device native id ({@link deviceNativeId}) -> adopted CamStack device id. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * Map live Homematic devices to adoption candidates for the discovery panel.
 * Devices whose channels don't map to any supported `DeviceType` (i.e.
 * `Generic`) are omitted — remotes, key transceivers, maintenance channels,
 * and any device with no recognised channel type fall into this category.
 * Pure: no network I/O, no side effects.
 */
export function buildHmCandidates(input: BuildHmCandidatesInput): DiscoveredChildDevice[] {
  const out: DiscoveredChildDevice[] = []

  for (const device of input.devices) {
    const type = inferHmDeviceType(device)
    if (type === DeviceType.Generic) continue

    // Deduplicate caps across channels (e.g. a BSM switch + energy-meter
    // both contribute distinct caps; dedup prevents duplicates if the same
    // cap name is mapped by two channels on a multi-relay device).
    const caps = [...new Set(mapHmDeviceChannels(device).flatMap((m) => m.mapping.capabilities))]

    const nativeId = deviceNativeId(input.integrationId, device.address)
    const adoptedId = input.adopted.get(nativeId) ?? null

    // First CCU room → the source location the adoption flow can import.
    // Omitted entirely when the device carries no room (keeps `metadata` valid
    // — `externalLocation` is an optional field, never `undefined`-valued).
    const externalLocation = device.rooms?.[0]

    // Per-entity preview children for the modal accordion. The entityKey reuses
    // the SAME suffix scheme the Container's getAccessoryChildren() uses, so a
    // preview entity and the eventual spawned accessory line up. Entity-level adoption is a separate
    // task; previews are NOT individually adoptable yet (alreadyAdopted=false).
    const children: DiscoveredChildDevice[] = deriveHmEntityPreviews(device).map((entity) => ({
      childNativeId: entityNativeId(input.integrationId, device.address, entity.key),
      name: entity.name,
      type: entity.type,
      status: 'online',
      metadata: {},
      alreadyAdopted: false,
      adoptedDeviceId: null,
      capabilities: entity.capabilities,
    }))

    out.push({
      childNativeId: nativeId,
      name: device.name ?? device.address,
      type,
      status: 'online',
      metadata: {
        serialNumber: device.address,
        // `HmDevice.type` carries the CCU device-type string (e.g. 'HmIP-BSM'),
        // which is the closest available model identifier on the wire format.
        model: device.type,
        ...(externalLocation !== undefined ? { externalLocation } : {}),
      },
      alreadyAdopted: adoptedId !== null,
      adoptedDeviceId: adoptedId,
      capabilities: caps,
      children,
    })
  }

  return out
}
