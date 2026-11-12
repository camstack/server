import {
  DeviceType,
  type DiscoveredChildDevice,
  deviceAdminLinkCapability,
  gatewayDeviceName,
} from '@camstack/types'

/** The `childNativeId` of the server itself (the Gateway), one per integration. */
export const UNRAID_GATEWAY_ID = 'gateway'

/**
 * The `childNativeId` of the single instance Container, one per integration. The
 * Container fans every array / disk / docker / notification entity out as accessory
 * children.
 */
export const UNRAID_INSTANCE_ID = 'instance'

/** The device `stableId` of an Unraid device: one Gateway and one Container per integration. */
export function unraidStableId(integrationId: string, nativeId: string): string {
  return `unraid:${integrationId}:${nativeId}`
}

/** Inputs for {@link buildUnraidCandidates}. */
export interface BuildUnraidCandidatesInput {
  /** The server behind the integration: its name, and whether its last poll succeeded. */
  readonly server: {
    readonly name: string
    readonly online: boolean
    /** Hostname the server reported. Absent: the gateway is named "Unraid". */
    readonly hostname?: string | null
  }
  /** Adopted device id per native id (`gateway`, `instance`). */
  readonly adopted: ReadonlyMap<string, number>
}

const METADATA = { manufacturer: 'Unraid', integration: 'unraid' } as const

/**
 * The server ({@link DeviceType.Gateway}, with a link to its WebGUI) and the SINGLE
 * {@link DeviceType.Container} of its instance, as SIBLINGS: neither parents the other.
 * Unlike Velux (one candidate per actuator node) or Ecowitt (three group Containers),
 * Unraid exposes exactly one Container per integration; the array / disk / docker /
 * notification entities materialise as its accessory children, not as candidates. Pure.
 */
export function buildUnraidCandidates(
  input: BuildUnraidCandidatesInput,
): readonly DiscoveredChildDevice[] {
  const status = input.server.online ? 'online' : 'offline'
  const gatewayAdopted = input.adopted.get(UNRAID_GATEWAY_ID) ?? null
  const instanceAdopted = input.adopted.get(UNRAID_INSTANCE_ID) ?? null
  return [
    {
      childNativeId: UNRAID_GATEWAY_ID,
      name: gatewayDeviceName('Unraid', input.server.hostname),
      type: DeviceType.Gateway,
      status,
      metadata: METADATA,
      alreadyAdopted: gatewayAdopted !== null,
      adoptedDeviceId: gatewayAdopted,
      capabilities: [deviceAdminLinkCapability.name],
    },
    {
      childNativeId: UNRAID_INSTANCE_ID,
      name: input.server.name,
      type: DeviceType.Container,
      status,
      metadata: METADATA,
      alreadyAdopted: instanceAdopted !== null,
      adoptedDeviceId: instanceAdopted,
    },
  ]
}
