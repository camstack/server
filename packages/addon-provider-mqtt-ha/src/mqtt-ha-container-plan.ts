import type { MqttHaDiscoveredEntity } from './mqtt-ha-discovery-types.js'
import type { MqttHaPhysicalDevice } from './mqtt-ha-device-grouping.js'
import {
  classifyMqttHaEntity,
  isActuatorEntity,
  planMqttHaDevice,
  type MqttHaDevicePlan,
} from './mqtt-ha-domain-mapping.js'

/** One function of a multi-actuator device: a child of the Container. */
export interface MqttHaGangPlan {
  /** The actuator's entity key; also the child's candidate id. */
  readonly nativeId: string
  readonly name: string
  readonly plan: MqttHaDevicePlan
}

export interface MqttHaContainerPlan {
  readonly gangs: readonly MqttHaGangPlan[]
}

const FIELD = /value_json(?:\.([A-Za-z0-9_]+)|\[['"]([^'"]+)['"]\])/

function fieldOf(entity: MqttHaDiscoveredEntity): string | null {
  const m = entity.valueTemplate === null ? null : FIELD.exec(entity.valueTemplate)
  return m === null ? null : (m[1] ?? m[2] ?? null)
}

/** The endpoint token of an actuator field: `state_l1` -> `l1`. */
function endpointToken(entity: MqttHaDiscoveredEntity): string | null {
  const field = fieldOf(entity)
  const cut = field === null ? -1 : field.indexOf('_')
  return field === null || cut < 0 ? null : field.slice(cut + 1)
}

function belongsToEndpoint(entity: MqttHaDiscoveredEntity, token: string): boolean {
  return fieldOf(entity)?.endsWith(`_${token}`) === true
}

function gangName(device: MqttHaPhysicalDevice, actuator: MqttHaDiscoveredEntity): string {
  return actuator.name === device.name ? actuator.name : `${device.name} ${actuator.name}`
}

/**
 * A device with several actuators (a multi-gang switch or relay) is ONE
 * Container with a child per gang. A meter goes to the gang whose endpoint
 * token its payload field carries (`power_l2` -> the gang of `state_l2`);
 * everything else - a device-wide meter, battery - goes to the FIRST gang,
 * never the container (device history does not record containers).
 * Null for a single-function device.
 */
export function planMqttHaContainer(device: MqttHaPhysicalDevice): MqttHaContainerPlan | null {
  if (device.kind !== 'device') return null
  const actuators = device.entities.filter(isActuatorEntity)
  if (actuators.length < 2) return null
  const tokens = actuators.map(endpointToken)
  const rest = device.entities.filter((e) => !actuators.includes(e))
  const claimedBy = (e: MqttHaDiscoveredEntity): number => {
    if (classifyMqttHaEntity(e)?.kind !== 'meter') return -1
    return tokens.findIndex((t) => t !== null && belongsToEndpoint(e, t))
  }
  const gangs: MqttHaGangPlan[] = []
  for (const [index, actuator] of actuators.entries()) {
    const own = rest.filter((e) => claimedBy(e) === index)
    const unclaimed = index === 0 ? rest.filter((e) => claimedBy(e) < 0) : []
    const plan = planMqttHaDevice({ entities: [actuator, ...own, ...unclaimed] })
    if (plan === null) continue
    gangs.push({ nativeId: actuator.entityKey, name: gangName(device, actuator), plan })
  }
  return gangs.length >= 2 ? { gangs } : null
}
