import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import type { EchoDevice } from './speak/worker-protocol.js'
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

/** `echo:<serial>`: how an Echo is named among an account's adoption candidates. */
export const ECHO_NATIVE_ID_PREFIX = 'echo:'

export function echoNativeId(serial: string): string {
  return `${ECHO_NATIVE_ID_PREFIX}${serial}`
}

/** The serial an Echo candidate id names, or null when the id is not an Echo's. */
export function echoSerialOf(childNativeId: string): string | null {
  if (!childNativeId.startsWith(ECHO_NATIVE_ID_PREFIX)) return null
  const serial = childNativeId.slice(ECHO_NATIVE_ID_PREFIX.length)
  return serial === '' ? null : serial
}

/** An Echo the adoption list offers: a media player, a flat sibling under the Alexa integration. */
export function isAdoptableEcho(device: EchoDevice): boolean {
  // A multi-room group is not a speaker: it has no player of its own.
  return device.kind === 'device'
}

export function buildAlexaEchoCandidate(input: {
  readonly device: EchoDevice
  /** Adopted CamStack device id for this Echo, or null when not adopted. */
  readonly adoptedDeviceId: number | null
}): DiscoveredChildDevice {
  const { device, adoptedDeviceId } = input
  return {
    childNativeId: echoNativeId(device.id),
    name: device.name.length > 0 ? device.name : device.id,
    type: DeviceType.MediaPlayer,
    status: device.online ? 'online' : 'offline',
    metadata: {
      manufacturer: 'Amazon',
      ...(device.room !== undefined ? { externalLocation: device.room } : {}),
    },
    alreadyAdopted: adoptedDeviceId !== null,
    adoptedDeviceId,
    capabilities: ['media-player', 'do-not-disturb'],
  }
}
