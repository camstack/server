import { DeviceType, type DiscoveredChildDevice, presenceCapability } from '@camstack/types'
import type { UnifiClientSnapshot, UnifiInfraSnapshot } from './unifi-client-contract.js'

/**
 * The `childNativeId` an infra Container candidate is keyed on. The controller
 * device id is stable across reboots; it is namespaced under the controller
 * stableId so two controllers never collide.
 */
export function infraNativeId(controllerId: string, id: string): string {
  return `${controllerId}:infra:${id}`
}

/** The `childNativeId` a network-client Presence candidate is keyed on. */
export function clientNativeId(controllerId: string, mac: string): string {
  return `${controllerId}:client:${mac}`
}

/** Discriminated result of parsing a `childNativeId`. */
export type ParsedNativeId =
  | { readonly kind: 'infra'; readonly id: string }
  | { readonly kind: 'client'; readonly mac: string }
  | null

/** Parse an infra / client `childNativeId` back into its discriminant + key. */
export function parseNativeId(childNativeId: string): ParsedNativeId {
  const infraMarker = ':infra:'
  const clientMarker = ':client:'
  const infraIdx = childNativeId.lastIndexOf(infraMarker)
  if (infraIdx >= 0) {
    return { kind: 'infra', id: childNativeId.slice(infraIdx + infraMarker.length) }
  }
  const clientIdx = childNativeId.lastIndexOf(clientMarker)
  if (clientIdx >= 0) {
    return { kind: 'client', mac: childNativeId.slice(clientIdx + clientMarker.length) }
  }
  return null
}

/** Inputs for {@link buildDiscoveryCandidates}. */
export interface BuildDiscoveryCandidatesInput {
  readonly controllerId: string
  readonly controllerName: string
  readonly infra: readonly UnifiInfraSnapshot[]
  readonly clients: readonly UnifiClientSnapshot[]
  /** Adopted device id per infra id, or null when not adopted. */
  readonly adoptedInfraIdById: Readonly<Record<string, number | null>>
  /** Adopted device id per client MAC, or null when not adopted. */
  readonly adoptedClientIdByMac: Readonly<Record<string, number | null>>
}

/**
 * Build one {@link DeviceType.Container} candidate per infra device and one
 * {@link DeviceType.Presence} candidate per network client. Pure — no I/O.
 * Unit-testable in isolation.
 */
export function buildDiscoveryCandidates(
  input: BuildDiscoveryCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const infraCandidates: DiscoveredChildDevice[] = input.infra.map((device) => {
    const adoptedDeviceId = input.adoptedInfraIdById[device.id] ?? null
    return {
      childNativeId: infraNativeId(input.controllerId, device.id),
      name: device.name.length > 0 ? device.name : `${input.controllerName} — ${device.model}`,
      type: DeviceType.Container,
      status: device.online ? 'online' : 'offline',
      metadata: { model: device.model, manufacturer: 'Ubiquiti', integration: 'unifi' },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
    } satisfies DiscoveredChildDevice
  })

  const clientCandidates: DiscoveredChildDevice[] = input.clients.map((client) => {
    const adoptedDeviceId = input.adoptedClientIdByMac[client.mac] ?? null
    return {
      childNativeId: clientNativeId(input.controllerId, client.mac),
      name: client.hostname.length > 0 ? client.hostname : client.mac,
      type: DeviceType.Presence,
      status: client.connected ? 'online' : 'offline',
      metadata: { uid: client.mac, manufacturer: 'Ubiquiti', integration: 'unifi' },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      capabilities: [presenceCapability.name],
    } satisfies DiscoveredChildDevice
  })

  return [...infraCandidates, ...clientCandidates]
}
