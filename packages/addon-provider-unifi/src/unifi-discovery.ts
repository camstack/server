import {
  deviceAdminLinkCapability,
  DeviceType,
  type DiscoveredChildDevice,
  presenceCapability,
} from '@camstack/types'
import type { UnifiClientSnapshot, UnifiInfraSnapshot } from './unifi-client-contract.js'

/** The `childNativeId` of the controller's own Gateway candidate. */
export const UNIFI_GATEWAY_ID = 'gateway'

/** The `childNativeId` an infra Container candidate is keyed on. */
export function infraNativeId(id: string): string {
  return `infra:${id}`
}

/** The `childNativeId` a network-client Presence candidate is keyed on. */
export function clientNativeId(mac: string): string {
  return `client:${mac}`
}

/** One stable id per candidate: `unifi:<integrationId>:<childNativeId>`. */
export function unifiStableId(integrationId: string, childNativeId: string): string {
  return `unifi:${integrationId}:${childNativeId}`
}

/** Discriminated result of parsing a `childNativeId`. */
export type ParsedNativeId =
  | { readonly kind: 'gateway' }
  | { readonly kind: 'infra'; readonly id: string }
  | { readonly kind: 'client'; readonly mac: string }
  | null

/** Parse a candidate `childNativeId` back into its discriminant + key. */
export function parseNativeId(childNativeId: string): ParsedNativeId {
  if (childNativeId === UNIFI_GATEWAY_ID) return { kind: 'gateway' }
  if (childNativeId.startsWith('infra:')) {
    return { kind: 'infra', id: childNativeId.slice('infra:'.length) }
  }
  if (childNativeId.startsWith('client:')) {
    return { kind: 'client', mac: childNativeId.slice('client:'.length) }
  }
  return null
}

/** Inputs for {@link buildDiscoveryCandidates}. */
export interface BuildDiscoveryCandidatesInput {
  readonly controllerName: string
  /** Whether the controller answered its last poll. */
  readonly controllerOnline: boolean
  readonly infra: readonly UnifiInfraSnapshot[]
  readonly clients: readonly UnifiClientSnapshot[]
  /** Adopted device id per `childNativeId`. */
  readonly adopted: ReadonlyMap<string, number>
}

/**
 * Build the candidates of one integration: the controller's {@link DeviceType.Gateway},
 * one {@link DeviceType.Container} per infra device and one {@link DeviceType.Presence}
 * per network client. All are top-level siblings; none nests another. Pure, no I/O.
 */
export function buildDiscoveryCandidates(
  input: BuildDiscoveryCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const adoptedOf = (nativeId: string): number | null => input.adopted.get(nativeId) ?? null

  const gatewayAdopted = adoptedOf(UNIFI_GATEWAY_ID)
  const gateway: DiscoveredChildDevice = {
    childNativeId: UNIFI_GATEWAY_ID,
    name: input.controllerName,
    type: DeviceType.Gateway,
    status: input.controllerOnline ? 'online' : 'offline',
    metadata: { manufacturer: 'Ubiquiti', integration: 'unifi' },
    alreadyAdopted: gatewayAdopted !== null,
    adoptedDeviceId: gatewayAdopted,
    capabilities: [deviceAdminLinkCapability.name],
  }

  const infraCandidates: DiscoveredChildDevice[] = input.infra.map((device) => {
    const nativeId = infraNativeId(device.id)
    const adoptedDeviceId = adoptedOf(nativeId)
    return {
      childNativeId: nativeId,
      name: device.name.length > 0 ? device.name : `${input.controllerName} — ${device.model}`,
      type: DeviceType.Container,
      status: device.online ? 'online' : 'offline',
      metadata: { model: device.model, manufacturer: 'Ubiquiti', integration: 'unifi' },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
    } satisfies DiscoveredChildDevice
  })

  const clientCandidates: DiscoveredChildDevice[] = input.clients.map((client) => {
    const nativeId = clientNativeId(client.mac)
    const adoptedDeviceId = adoptedOf(nativeId)
    return {
      childNativeId: nativeId,
      name: client.hostname.length > 0 ? client.hostname : client.mac,
      type: DeviceType.Presence,
      status: client.connected ? 'online' : 'offline',
      metadata: { uid: client.mac, manufacturer: 'Ubiquiti', integration: 'unifi' },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      capabilities: [presenceCapability.name],
    } satisfies DiscoveredChildDevice
  })

  return [gateway, ...infraCandidates, ...clientCandidates]
}
