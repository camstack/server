import {
  deviceAdminLinkCapability,
  type DiscoveredChildDevice,
  powerMeterCapability,
  presenceCapability,
  workloadCapability,
} from '@camstack/types'
import type { UnifiClientSnapshot, UnifiInfraSnapshot } from './unifi-client-contract.js'
import { hasPoePort } from './unifi-port-state.js'
import { unifiDeviceTarget } from './unifi-device-kind.js'
import {
  buildInfraFeatures,
  capsForDescriptor,
  deviceTypeForDescriptor,
  featureLabel,
  featureSuffix,
  portClientNamerOf,
  type UnifiPortClientNamer,
} from './unifi-mapping.js'

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
  | { readonly kind: 'infra'; readonly id: string }
  | { readonly kind: 'client'; readonly mac: string }
  | null

/** Parse a candidate `childNativeId` back into its discriminant + key. */
export function parseNativeId(childNativeId: string): ParsedNativeId {
  if (childNativeId.startsWith('infra:')) {
    const id = childNativeId.slice('infra:'.length)
    // `infra:<id>:poe-<n>` is a port under its infra device, adopted with it, never alone.
    return id.includes(':') ? null : { kind: 'infra', id }
  }
  if (childNativeId.startsWith('client:')) {
    return { kind: 'client', mac: childNativeId.slice('client:'.length) }
  }
  return null
}

/**
 * What a console Host serves beyond its children: the workload (with `restart`, the controller's
 * `restartDevice`) and the link to the controller UI. A switch or an access point restarts
 * through its own workload too, and is proposed without these hints.
 */
const CONSOLE_CAPABILITIES: readonly string[] = [
  workloadCapability.name,
  deviceAdminLinkCapability.name,
]

/** The PoE ports of an infra device, proposed under it: the port devices its adoption spawns. */
function poePortCandidates(
  device: UnifiInfraSnapshot,
  status: DiscoveredChildDevice['status'],
  portClientName: UnifiPortClientNamer,
): readonly DiscoveredChildDevice[] {
  const parentNativeId = infraNativeId(device.id)
  return buildInfraFeatures(device)
    .filter((f) => f.kind === 'port')
    .map((feature) => ({
      childNativeId: `${parentNativeId}:${featureSuffix(feature)}`,
      name: featureLabel(
        feature,
        feature.portIdx === undefined
          ? null
          : portClientName({ infraId: device.id, portIdx: feature.portIdx }),
      ),
      type: deviceTypeForDescriptor(feature),
      status,
      metadata: { manufacturer: 'Ubiquiti', integration: 'unifi' },
      alreadyAdopted: false,
      adoptedDeviceId: null,
      capabilities: [...capsForDescriptor(feature)],
    }))
}

export interface BuildDiscoveryCandidatesInput {
  readonly controllerName: string
  /** Whether the controller answered its last poll. */
  readonly controllerOnline: boolean
  readonly infra: readonly UnifiInfraSnapshot[]
  readonly clients: readonly UnifiClientSnapshot[]
  /** Adopted device id per `childNativeId`. */
  readonly adopted: ReadonlyMap<string, number>
  /** Names a PoE port after its client (planning#583); default: the client on the snapshot. */
  readonly portClientName?: UnifiPortClientNamer
}

/**
 * Build the candidates of one integration: one candidate per infra device (a console is the
 * workload Host the integration talks to — there is no Gateway, D1064) and one per network
 * client, each typed by `unifiDeviceTarget` (the one table). All are top-level siblings; an infra device nests only its PoE ports, the switch children its adoption
 * spawns. Pure, no I/O.
 */
export function buildDiscoveryCandidates(
  input: BuildDiscoveryCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const adoptedOf = (nativeId: string): number | null => input.adopted.get(nativeId) ?? null
  const portClientName = input.portClientName ?? portClientNamerOf(input.infra)

  const infraCandidates: DiscoveredChildDevice[] = input.infra.map((device) => {
    const nativeId = infraNativeId(device.id)
    const adoptedDeviceId = adoptedOf(nativeId)
    const status = device.online ? 'online' : 'offline'
    const ports = poePortCandidates(device, status, portClientName)
    const capabilities = [
      ...(device.kind === 'console' ? CONSOLE_CAPABILITIES : []),
      ...(hasPoePort(device.ports) ? [powerMeterCapability.name] : []),
    ]
    return {
      childNativeId: nativeId,
      name: device.name.length > 0 ? device.name : `${input.controllerName} — ${device.model}`,
      type: unifiDeviceTarget(device.kind).type,
      status,
      metadata: {
        model: device.model,
        manufacturer: 'Ubiquiti',
        integration: 'unifi',
      },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(ports.length > 0 ? { children: ports } : {}),
    } satisfies DiscoveredChildDevice
  })

  const clientCandidates: DiscoveredChildDevice[] = input.clients.map((client) => {
    const nativeId = clientNativeId(client.mac)
    const adoptedDeviceId = adoptedOf(nativeId)
    return {
      childNativeId: nativeId,
      name: client.hostname.length > 0 ? client.hostname : client.mac,
      type: unifiDeviceTarget('client').type,
      status: client.connected ? 'online' : 'offline',
      metadata: {
        uid: client.mac,
        manufacturer: 'Ubiquiti',
        integration: 'unifi',
      },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      capabilities: [presenceCapability.name],
    } satisfies DiscoveredChildDevice
  })

  return [...infraCandidates, ...clientCandidates]
}
