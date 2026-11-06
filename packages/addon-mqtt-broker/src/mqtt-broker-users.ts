import {
  assertInstanceUnused,
  type InstanceUserFinder,
  fieldUserFinder,
  type ListedFieldRow,
} from '@camstack/types'

/** The addon whose integrations name an MQTT broker, and the field they keep that id in. */
export const MQTT_HA_ADDON_ID = 'provider-mqtt-ha'
export const MQTT_HA_BROKER_FIELD = 'mqttBrokerId'

/** The finders for everything that still points at an MQTT broker. */
export function mqttBrokerUsers(
  listMqttHaInstances: () => Promise<readonly ListedFieldRow[]>,
): readonly InstanceUserFinder[] {
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
  return assertInstanceUnused(brokerId, mqttBrokerUsers(listMqttHaInstances))
}

/** The calls `listMqttHaInstancesOver` makes, narrowed from `ctx.api`. */
export interface MqttHaListApi {
  readonly capabilities: {
    readonly getCapability: {
      query(input: {
        readonly name: string
      }): Promise<{ readonly providers: readonly string[] } | null>
    }
  }
  readonly addons: {
    readonly list: {
      query(): Promise<readonly { readonly manifest: { readonly id: string } }[]>
    }
  }
  readonly integrationInstances: {
    readonly listInstances: {
      query(input: { readonly addonId: string }): Promise<readonly ListedFieldRow[]>
    }
  }
}

/** MQTT Discovery is installed but has not registered as a provider: not known, NOT absent (D315). */
export class MqttDiscoveryNotReadyError extends Error {
  constructor() {
    super(
      'MQTT Discovery is installed but not answering yet (still starting, or switched off), so ' +
        'its integrations cannot be checked: try again once it is running',
    )
    this.name = 'MqttDiscoveryNotReadyError'
  }
}

/**
 * The integrations of the MQTT Discovery addon. Nothing can name a broker only when the registry
 * ANSWERED that the addon supplies no `integration-instances` AND the addon roster ANSWERED that
 * it is not installed: then the answer is none. An addon that is installed but has not registered
 * (booting, switched off) is not-yet-known, and a registry or roster that does not answer, or a
 * read that fails, is unknown too: all of those throw, so the delete is refused (D49, D315).
 */
export async function listMqttHaInstancesOver(
  api: MqttHaListApi,
): Promise<readonly ListedFieldRow[]> {
  const info = await api.capabilities.getCapability.query({ name: 'integration-instances' })
  if (info === null) throw new Error('the capability registry did not answer')
  if (!info.providers.includes(MQTT_HA_ADDON_ID)) {
    const roster = await api.addons.list.query()
    if (roster.some((row) => row.manifest.id === MQTT_HA_ADDON_ID)) {
      throw new MqttDiscoveryNotReadyError()
    }
    return []
  }
  return api.integrationInstances.listInstances.query({ addonId: MQTT_HA_ADDON_ID })
}
