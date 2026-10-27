import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'
import { groupEntitiesByDevice, type MqttHaPhysicalDevice } from './mqtt-ha-device-grouping.js'
import { planMqttHaContainer, type MqttHaContainerPlan } from './mqtt-ha-container-plan.js'
import { planMqttHaDevice, type MqttHaDevicePlan } from './mqtt-ha-domain-mapping.js'

/**
 * A physical device the operator can adopt: one plain device, or - when it has
 * several actuators - a Container with a child per gang.
 */
export type MqttHaAdoptable =
  | {
      readonly kind: 'single'
      readonly device: MqttHaPhysicalDevice
      readonly plan: MqttHaDevicePlan
    }
  | {
      readonly kind: 'container'
      readonly device: MqttHaPhysicalDevice
      readonly container: MqttHaContainerPlan
    }

/** Group a broker's entities into devices and keep those that map onto a cap. */
export function adoptableMqttHaDevices(
  entities: readonly MqttHaDiscoveredEntity[],
): MqttHaAdoptable[] {
  const out: MqttHaAdoptable[] = []
  for (const device of groupEntitiesByDevice(entities)) {
    const container = planMqttHaContainer(device)
    if (container !== null) {
      out.push({ kind: 'container', device, container })
      continue
    }
    const plan = planMqttHaDevice(device)
    if (plan !== null) out.push({ kind: 'single', device, plan })
  }
  return out
}

function candidateOf(input: {
  readonly nativeId: string
  readonly name: string
  readonly device: MqttHaPhysicalDevice
  readonly plan: MqttHaDevicePlan
  readonly adoptedDeviceId: number | null
}): DiscoveredChildDevice {
  const { device, plan } = input
  return {
    childNativeId: input.nativeId,
    name: input.name,
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

export function buildMqttHaDeviceCandidate(input: {
  readonly adoptable: MqttHaAdoptable
  readonly adoptedDeviceId: number | null
}): DiscoveredChildDevice {
  const { adoptable, adoptedDeviceId } = input
  const { device } = adoptable
  if (adoptable.kind === 'single') {
    return candidateOf({
      nativeId: device.nativeId,
      name: device.name,
      device,
      plan: adoptable.plan,
      adoptedDeviceId,
    })
  }
  return {
    childNativeId: device.nativeId,
    name: device.name,
    type: DeviceType.Container,
    status: 'online',
    metadata: {
      ...(device.model !== null ? { model: device.model } : {}),
      ...(device.manufacturer !== null ? { manufacturer: device.manufacturer } : {}),
    },
    alreadyAdopted: adoptedDeviceId !== null,
    adoptedDeviceId,
    capabilities: [],
    children: adoptable.container.gangs.map((g) =>
      candidateOf({
        nativeId: g.nativeId,
        name: g.name,
        device,
        plan: g.plan,
        adoptedDeviceId: null,
      }),
    ),
  }
}
