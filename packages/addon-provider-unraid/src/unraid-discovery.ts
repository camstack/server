import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'

/**
 * The `childNativeId` the single instance Container candidate is keyed on. One
 * Unraid Hub adopts exactly ONE Container (the instance itself), which then fans
 * every array / disk / docker / notification entity out as accessory children.
 */
export function instanceNativeId(instanceId: string): string {
  return `${instanceId}:instance`
}

/** Inputs for {@link buildInstanceCandidate}. */
export interface BuildInstanceCandidateInput {
  readonly instanceId: string
  readonly instanceName: string
  readonly online: boolean
  /** The adopted Container's CamStack device id, or null when not yet adopted. */
  readonly adoptedDeviceId: number | null
}

/**
 * Build the SINGLE {@link DeviceType.Container} adoption candidate for an Unraid
 * instance. Pure — no I/O. Unit-testable in isolation. Unlike Velux (one
 * candidate per actuator node) or Ecowitt (three group Containers), Unraid
 * exposes exactly one Container per instance; the array/disk/docker/notification
 * entities materialise as its accessory children, not as adoption candidates.
 */
export function buildInstanceCandidate(input: BuildInstanceCandidateInput): DiscoveredChildDevice {
  return {
    childNativeId: instanceNativeId(input.instanceId),
    name: input.instanceName,
    type: DeviceType.Container,
    status: input.online ? 'online' : 'offline',
    metadata: { manufacturer: 'Unraid', integration: 'unraid' },
    alreadyAdopted: input.adoptedDeviceId !== null,
    adoptedDeviceId: input.adoptedDeviceId,
  }
}
