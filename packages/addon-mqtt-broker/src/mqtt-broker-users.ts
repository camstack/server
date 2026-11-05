import {
  assertBrokerUnused,
  type BrokerUserFinder,
  fieldUserFinder,
  type ListedFieldRow,
} from '@camstack/types'

/** The addon whose integrations name an MQTT broker, and the field they keep that id in. */
export const MQTT_HA_ADDON_ID = 'provider-mqtt-ha'
export const MQTT_HA_BROKER_FIELD = 'mqttBrokerId'

/** The finders for everything that still points at an MQTT broker. */
export function mqttBrokerUsers(
  listMqttHaInstances: () => Promise<readonly ListedFieldRow[]>,
): readonly BrokerUserFinder[] {
  return [
    fieldUserFinder({
      kind: 'integration',
      field: MQTT_HA_BROKER_FIELD,
      list: listMqttHaInstances,
    }),
  ]
}

/** Refuse removing an MQTT broker an MQTT Discovery integration still names. */
export function assertMqttBrokerUnused(
  brokerId: string,
  listMqttHaInstances: () => Promise<readonly ListedFieldRow[]>,
): Promise<void> {
  return assertBrokerUnused(brokerId, mqttBrokerUsers(listMqttHaInstances))
}
