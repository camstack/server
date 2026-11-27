import { mqttHaEntitySchema, type MqttHaEntity } from './mqtt-ha-discovery-types.js'
import { planMqttHaDevice, type MqttHaCap } from './mqtt-ha-domain-mapping.js'

/** What an adopted device persists about its entities and the caps they feed. */
export interface MqttHaDeviceLayout {
  readonly entities: readonly MqttHaEntity[]
  readonly skippedEntities: readonly MqttHaEntity[]
  readonly bindings: Readonly<Record<string, string>>
  readonly meter: Readonly<Record<string, string>>
  readonly air: Readonly<Record<string, string>>
  readonly capabilities: readonly string[]
}

export interface MqttHaLayoutChange {
  readonly layout: MqttHaDeviceLayout
  readonly addedCaps: readonly MqttHaCap[]
}

/** `base` plus the keys of `extra` it does not have; `base` keeps its order and values. */
function addMissing(
  base: Readonly<Record<string, string>>,
  extra: Readonly<Partial<Record<string, string>>>,
): Record<string, string> {
  const out: Record<string, string> = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && out[key] === undefined) out[key] = value
  }
  return out
}

function replaceKnown(
  list: readonly MqttHaEntity[],
  entity: MqttHaEntity,
): { readonly list: MqttHaEntity[]; readonly known: boolean } {
  let known = false
  const next = list.map((e) => {
    if (e.entityKey !== entity.entityKey) return e
    known = true
    return entity
  })
  return { list: next, known }
}

/**
 * Fold one (re)discovered entity of an adopted device into its layout. It only
 * ADDS: no discovery message tells a device its discovery is complete, so a
 * binding is never dropped because an entity has not arrived yet. Returns null
 * when nothing changes (same entity record, same plan) or the plan would move
 * the device to another type.
 */
export function followDiscovery(input: {
  readonly layout: MqttHaDeviceLayout
  readonly deviceType: string
  readonly entity: MqttHaEntity
}): MqttHaLayoutChange | null {
  const { layout } = input
  const entity = mqttHaEntitySchema.parse(input.entity)
  const inMembers = replaceKnown(layout.entities, entity)
  const inSkipped = replaceKnown(layout.skippedEntities, entity)
  const everything = [
    ...inMembers.list,
    ...inSkipped.list,
    ...(inMembers.known || inSkipped.known ? [] : [entity]),
  ]
  const plan = planMqttHaDevice({ entities: everything })
  if (plan === null || plan.deviceType !== input.deviceType) return null

  const bindings = addMissing(layout.bindings, plan.bindings)
  const meter = addMissing(layout.meter, plan.meter)
  const air = addMissing(layout.air, plan.air)
  const addedCaps = plan.capabilities.filter((cap) => !layout.capabilities.includes(cap))
  const capabilities = [...layout.capabilities, ...addedCaps]

  const feeding = new Set<string>([
    ...layout.entities.map((e) => e.entityKey),
    ...plan.members.map((e) => e.entityKey),
  ])
  const members = everything.filter((e) => feeding.has(e.entityKey))
  const skippedEntities = everything.filter((e) => !feeding.has(e.entityKey))
  const next: MqttHaDeviceLayout = {
    entities: members,
    skippedEntities,
    bindings,
    meter,
    air,
    capabilities,
  }
  if (JSON.stringify(next) === JSON.stringify(layout)) return null
  return { layout: next, addedCaps }
}
