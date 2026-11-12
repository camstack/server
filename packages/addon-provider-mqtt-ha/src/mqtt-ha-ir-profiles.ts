import type { IrNativeFormat } from '@camstack/types'
import type { MqttHaEntity } from './mqtt-ha-discovery-types.js'

/** Where the payload of one learn press is taken from. First hit wins. */
export type MqttHaIrPressSource =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'entity'; readonly field: 'payloadPress' | 'payloadOn' }

/**
 * One accepted way to start learning. A profile lists every shape a bridge
 * revision has used; the first whose entity is present matches.
 */
export interface MqttHaIrLearnShape {
  readonly component: 'select' | 'button'
  /** Object-id property (`learn_ir_code`, `switch_learn_ir_code`). */
  readonly property: string
  readonly press: readonly MqttHaIrPressSource[]
}

/**
 * How one family of IR blasters is wired over MQTT discovery. A profile names
 * the bridge that publishes it and the entities that make a transmitter;
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
    /** Each shape that can start learning, oldest first. */
    readonly learn: readonly MqttHaIrLearnShape[]
    /** Sensor whose string state is the last learned code. */
    readonly learned: string
  }
  readonly format: IrNativeFormat
}

/**
 * Zigbee2MQTT's zosung blaster. Older bridges expose learning as a select
 * (`learn_ir_code`, press publishes `ON`). Newer ones retype that binary as a
 * button whose object id is `switch_learn_ir_code`: the press is `payload_press`
 * when discovery sets it, otherwise the `payload_on` the binary expose still
 * carries (`ON`).
 */
const Z2M_ZOSUNG_LEARN: readonly MqttHaIrLearnShape[] = [
  {
    component: 'select',
    property: 'learn_ir_code',
    press: [{ kind: 'literal', value: 'ON' }],
  },
  {
    component: 'button',
    property: 'switch_learn_ir_code',
    press: [
      { kind: 'entity', field: 'payloadPress' },
      { kind: 'entity', field: 'payloadOn' },
    ],
  },
]

export const MQTT_HA_IR_PROFILES: readonly MqttHaIrProfile[] = [
  {
    id: 'z2m-zosung',
    origin: 'Zigbee2MQTT',
    entities: {
      send: 'ir_code_to_send',
      learn: Z2M_ZOSUNG_LEARN,
      learned: 'learned_ir_code',
    },
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
  /** What a learn press publishes. Taken from the matched learn shape. */
  readonly learnPayload: string
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

function pressPayload(
  entity: MqttHaEntity,
  sources: readonly MqttHaIrPressSource[],
): string | null {
  for (const source of sources) {
    if (source.kind === 'literal') return source.value
    const value = entity[source.field]
    if (value !== null && value.length > 0) return value
  }
  return null
}

interface LearnedPress {
  readonly learn: MqttHaEntity
  readonly learnTopic: string
  readonly learnPayload: string
}

/**
 * The first learn shape whose entity, command topic and press payload are all
 * present. A shape that matches but carries a `command_template` is refused:
 * this provider publishes a bare payload and cannot render one.
 */
function matchLearn(
  entities: readonly MqttHaEntity[],
  profile: MqttHaIrProfile,
  onRefused?: (reason: string) => void,
): LearnedPress | null {
  for (const shape of profile.entities.learn) {
    const learn = find(entities, profile, shape.component, shape.property)
    const learnTopic = learn?.commandTopic
    if (learn === undefined || !learnTopic) continue
    const learnPayload = pressPayload(learn, shape.press)
    if (learnPayload === null) continue
    if (learn.commandTemplate !== null) {
      onRefused?.(
        `ir profile ${profile.id} refused: ${learn.objectId} has a command_template this provider does not render`,
      )
      return null
    }
    return { learn, learnTopic, learnPayload }
  }
  return null
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
    const learned = find(entities, profile, 'sensor', profile.entities.learned)
    const sendTopic = send?.commandTopic
    const learnedTopic = learned?.stateTopic
    if (send === undefined || learned === undefined || !sendTopic || !learnedTopic) continue
    if (send.commandTemplate !== null) {
      onRefused?.(
        `ir profile ${profile.id} refused: ${send.objectId} has a command_template this provider does not render`,
      )
      continue
    }
    const learn = matchLearn(entities, profile, onRefused)
    if (learn === null) continue
    return { profile, send, learned, sendTopic, learnedTopic, ...learn }
  }
  return null
}
