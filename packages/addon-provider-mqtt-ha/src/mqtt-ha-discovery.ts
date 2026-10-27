import type { DiscoveredChildDevice } from '@camstack/types'
import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'
import { groupEntitiesByDevice, type MqttHaPhysicalDevice } from './mqtt-ha-device-grouping.js'
import { planMqttHaDevice, type MqttHaDevicePlan } from './mqtt-ha-domain-mapping.js'

/** A physical device the operator can adopt, with what it maps to. */
export interface MqttHaAdoptable {
  readonly device: MqttHaPhysicalDevice
  readonly plan: MqttHaDevicePlan
}

/** Group a broker's entities into devices and keep those that map onto a cap. */
export function adoptableMqttHaDevices(
  entities: readonly MqttHaDiscoveredEntity[],
): MqttHaAdoptable[] {
  const out: MqttHaAdoptable[] = []
  for (const device of groupEntitiesByDevice(entities)) {
    const plan = planMqttHaDevice(device)
    if (plan !== null) out.push({ device, plan })
  }
  return out
}

export function buildMqttHaDeviceCandidate(input: {
  readonly adoptable: MqttHaAdoptable
  readonly adoptedDeviceId: number | null
}): DiscoveredChildDevice {
  const { device, plan } = input.adoptable
  return {
    childNativeId: device.nativeId,
    name: device.name,
    type: plan.deviceType,
    status: 'online',
    metadata: {
      ...(device.model !== null ? { model: device.model } : {}),
      ...(device.manufacturer !== null ? { manufacturer: device.manufacturer } : {}),
      isBattery: plan.capabilities.includes('battery'),
    },
    alreadyAdopted: input.adoptedDeviceId !== null,
    adoptedDeviceId: input.adoptedDeviceId,
    capabilities: [...plan.capabilities],
  }
}
