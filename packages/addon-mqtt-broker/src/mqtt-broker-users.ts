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

/** The two calls `listMqttHaInstancesOver` makes, narrowed from `ctx.api`. */
export interface MqttHaListApi {
  readonly capabilities: {
    readonly getCapability: {
      query(input: {
        readonly name: string
      }): Promise<{ readonly providers: readonly string[] } | null>
    }
  }
  readonly integrationInstances: {
    readonly listInstances: {
      query(input: { readonly addonId: string }): Promise<readonly ListedFieldRow[]>
    }
  }
}

/**
 * The integrations of the MQTT Discovery addon. When the registry ANSWERS and that addon is not a
 * provider of `integration-instances` (not installed, disabled), nothing can name a broker, so the
 * answer is none. A registry that does not answer, or a read that fails, throws: a failed read
 * never lets a broker go (D49).
 */
export async function listMqttHaInstancesOver(
  api: MqttHaListApi,
): Promise<readonly ListedFieldRow[]> {
  const info = await api.capabilities.getCapability.query({ name: 'integration-instances' })
  if (info !== null && !info.providers.includes(MQTT_HA_ADDON_ID)) return []
  return api.integrationInstances.listInstances.query({ addonId: MQTT_HA_ADDON_ID })
}
