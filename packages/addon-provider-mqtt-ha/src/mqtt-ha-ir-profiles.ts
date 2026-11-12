import type { IrNativeFormat } from '@camstack/types'
import type { MqttHaEntity } from './mqtt-ha-discovery-types.js'

/**
 * How one family of IR blasters is wired over MQTT discovery. A profile names
 * the bridge that publishes it and the three entities that make a transmitter;
 * it is matched on `origin` and the entity object ids, never on a manufacturer
 * or a model.
 */
export interface MqttHaIrProfile {
  readonly id: string
  /** The discovery `origin.name` of the bridge. */
  readonly origin: string
  readonly entities: {
    /** Text the code to emit is published to. */
    readonly send: string
    /** Select whose `ON` starts learning. */
    readonly learn: string
    /** Sensor whose string state is the last learned code. */
    readonly learned: string
  }
  readonly format: IrNativeFormat
}

export const MQTT_HA_IR_PROFILES: readonly MqttHaIrProfile[] = [
  {
    id: 'z2m-zosung',
    origin: 'Zigbee2MQTT',
    entities: { send: 'ir_code_to_send', learn: 'learn_ir_code', learned: 'learned_ir_code' },
    format: 'tuya',
  },
]

/** The entities of one device that form a transmitter under a profile. */
export interface MqttHaIrMatch {
  readonly profile: MqttHaIrProfile
  readonly send: MqttHaEntity
  readonly learn: MqttHaEntity
  readonly learned: MqttHaEntity
  /** Command topics, non-null by construction: a profile without them never matches. */
  readonly sendTopic: string
  readonly learnTopic: string
  readonly learnedTopic: string
}

/** Z2M unique ids end with the bridge id (`<ieee>_<property>_zigbee2mqtt`). */
const BRIDGE_SUFFIX = /_zigbee2mqtt$/

function hasProperty(entity: MqttHaEntity, property: string): boolean {
  const candidates = [entity.objectId, (entity.uniqueId ?? '').replace(BRIDGE_SUFFIX, '')]
  return candidates.some((c) => c === property || c.endsWith(`_${property}`))
}

function find(
  entities: readonly MqttHaEntity[],
  profile: MqttHaIrProfile,
  component: MqttHaEntity['component'],
  property: string,
): MqttHaEntity | undefined {
  return entities.find(
    (e) => e.origin === profile.origin && e.component === component && hasProperty(e, property),
  )
}

/**
 * The first profile every one of whose entities is present, else null. A
 * profile publishes a bare payload on the discovered command topic, so an entity
 * whose discovery carries a `command_template` refuses the match, and the reason
 * goes to `onRefused`.
 */
export function matchIrProfile(
  entities: readonly MqttHaEntity[],
  onRefused?: (reason: string) => void,
): MqttHaIrMatch | null {
  for (const profile of MQTT_HA_IR_PROFILES) {
    const send = find(entities, profile, 'text', profile.entities.send)
    const learn = find(entities, profile, 'select', profile.entities.learn)
    const learned = find(entities, profile, 'sensor', profile.entities.learned)
    const sendTopic = send?.commandTopic
    const learnTopic = learn?.commandTopic
    const learnedTopic = learned?.stateTopic
    if (send && learn && learned && sendTopic && learnTopic && learnedTopic) {
      const templated = [send, learn].find((e) => e.commandTemplate !== null)
      if (templated !== undefined) {
        onRefused?.(
          `ir profile ${profile.id} refused: ${templated.objectId} has a command_template this provider does not render`,
        )
        continue
      }
      return { profile, send, learn, learned, sendTopic, learnTopic, learnedTopic }
    }
  }
  return null
}
