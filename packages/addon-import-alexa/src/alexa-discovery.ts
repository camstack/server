import type { DiscoveredChildDevice } from '@camstack/types'
import type { AlexaAppliance } from './alexa-client.js'
import { mapAlexaCapabilitiesToCamStack } from './alexa-domain-mapping.js'

/**
 * Build one adoption candidate per Alexa appliance. Pure: no I/O, no
 * alexa-remote2 import. Each appliance maps to a single device (one cap set);
 * appliances with no recognised capability interface are skipped by the adoption
 * layer (`mappableAppliance` returns false).
 *
 * Unlike Ecowitt/Matter (a gateway/node fans out children), an Alexa appliance
 * is a flat device — a colour bulb registers switch+brightness+color on ONE
 * device, not a container. So candidates are standalone, not Containers.
 */
export function buildAlexaApplianceCandidate(input: {
  readonly appliance: AlexaAppliance
  /** Adopted CamStack device id for this appliance, or null when not adopted. */
  readonly adoptedDeviceId: number | null
}): DiscoveredChildDevice {
  const { appliance, adoptedDeviceId } = input
  const mapping = mapAlexaCapabilitiesToCamStack(appliance.interfaces)
  return {
    childNativeId: appliance.applianceId,
    name: appliance.name,
    type: mapping.deviceType,
    status: 'online',
    metadata: {
      ...(appliance.manufacturer !== undefined ? { manufacturer: appliance.manufacturer } : {}),
      ...(appliance.groupName !== undefined ? { externalLocation: appliance.groupName } : {}),
    },
    alreadyAdopted: adoptedDeviceId !== null,
    adoptedDeviceId,
    capabilities: [...mapping.capabilities],
  }
}

/** True when an appliance maps to at least one cap (worth surfacing/adopting). */
export function mappableAppliance(appliance: AlexaAppliance): boolean {
  return mapAlexaCapabilitiesToCamStack(appliance.interfaces).capabilities.length > 0
}
