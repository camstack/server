/**
 * MQTT Discovery integrations as `integration-instances` (planning#416, D985, D1007): one
 * `connections` record per integration under the `integrations` registry id. The body holds the
 * LINK to an MQTT broker, `mqttBrokerId`: the id of an `mqtt-broker` instance, never a copy of that
 * broker's host or credentials, which stay with the broker.
 */
import {
  type AddonMigration,
  type ConfigUISchema,
  defineEntryKind,
  entryBody,
  type IntegrationRowsApi,
  type SecretsAccess,
  type IntegrationRowsPorts,
  integrationRowsPortsOverApi,
  moveIntegrationRowsToRecords,
  RecordIntegrationInstances,
  type RecordsAccess,
  type RowsMigrationLog,
} from '@camstack/types'
import { z } from 'zod'

export const mqttHaConnectionsEntryKind = defineEntryKind('connections', {
  title: 'MQTT Discovery integrations',
  schema: entryBody({ mqttBrokerId: z.string().min(1).optional() }),
  writeTrigger: 'an operator links an MQTT Discovery integration to an MQTT broker',
})
export type MqttHaConnectionBody = z.infer<typeof mqttHaConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const mqttHaRecordKinds = { connections: mqttHaConnectionsEntryKind } as const

/** The form: one picker over the `mqtt` brokers; the link is stored as that broker's id. */
export function buildMqttHaConnectionForm(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'mqtt-ha-broker-link',
        title: 'MQTT broker',
        titleKey: 'provider-mqtt-ha:globalSettings.s_mqtt-ha-broker-link.title',
        description:
          'Each integration instance links to an MQTT broker (Connectivity → MQTT brokers).',
        descriptionKey: 'provider-mqtt-ha:globalSettings.s_mqtt-ha-broker-link.description',
        columns: 1,
        fields: [
          {
            type: 'broker-select',
            key: 'mqttBrokerId',
            label: 'MQTT broker',
            labelKey: 'provider-mqtt-ha:globalSettings.s_mqtt-ha-broker-link.mqttBrokerId.label',
            brokerKind: 'mqtt',
          },
          {
            type: 'info',
            key: 'help',
            label: 'Broker link',
            labelKey: 'provider-mqtt-ha:globalSettings.s_mqtt-ha-broker-link.help.label',
            content: 'Entities appear under Integrations → Adopt once discovery messages arrive.',
          },
        ],
      },
    ],
  }
}

/** The legacy rows named the link `mqttBrokerId`, or `brokerId` before that. */
const LEGACY_KEYS: readonly string[] = ['mqttBrokerId', 'brokerId']

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The record body of one integration, from its legacy rows. The older `brokerId` spelling ends here. */
export function mqttHaBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: { readonly id: string; readonly name: string },
): MqttHaConnectionBody {
  const dropped = Object.keys(values).filter((key) => !LEGACY_KEYS.includes(key))
  if (dropped.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${dropped.join(', ')}`,
    )
  }
  const mqttBrokerId = text(values['mqttBrokerId']) ?? text(values['brokerId'])
  return { name: integration.name, ...(mqttBrokerId !== undefined ? { mqttBrokerId } : {}) }
}

export const MQTT_HA_ROWS_TO_RECORD_ID = 'provider-mqtt-ha/2026-11-05-integration-rows-to-record'

/** The whole `provider-mqtt-ha` catalogue (D987): offered to the engine at `onInitialize`. */
export const MQTT_HA_MIGRATIONS: readonly AddonMigration<IntegrationRowsPorts>[] = [
  {
    meta: {
      id: MQTT_HA_ROWS_TO_RECORD_ID,
      owner: 'provider-mqtt-ha',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move every MQTT Discovery integration into a typed instance record keyed by its registry id (its broker link as `mqttBrokerId`), then clear the legacy integration settings rows',
      fixtureMark: 'a legacy setting key the migration does not know',
    },
    procedure: (ports) =>
      moveIntegrationRowsToRecords(ports, {
        addonId: 'provider-mqtt-ha',
        secretPaths: mqttHaConnectionsEntryKind.declaration.secretPaths,
        bodyFrom: mqttHaBodyFromRows,
      }),
  },
]

/** The hub side and the records side of the move, over `ctx.api` and `ctx.records`. */
export function mqttHaRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: Pick<RecordsAccess, 'kind'>
  readonly warn: (message: string) => void
  readonly secrets?: SecretsAccess | null
}): IntegrationRowsPorts {
  return integrationRowsPortsOverApi({
    api: deps.api,
    ...(deps.secrets !== undefined ? { secrets: deps.secrets } : {}),
    records: deps.records.kind({
      name: mqttHaConnectionsEntryKind.name,
      declaration: mqttHaConnectionsEntryKind.declaration,
      schema: z.record(z.string(), z.unknown()),
    }),
    log: { warn: deps.warn },
  })
}

/** The broker an integration links to, from its record; undefined while it links to none. */
export async function mqttHaBrokerIdOf(
  instances: Pick<RecordIntegrationInstances<MqttHaConnectionBody>, 'getResolved'>,
  id: string,
): Promise<string | undefined> {
  return (await instances.getResolved(id))?.mqttBrokerId
}

export interface MqttHaInstancesDeps {
  /** Bring the sessions in line with the records after a change. */
  readonly onChanged: () => Promise<void>
}

export function buildMqttHaInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: MqttHaInstancesDeps,
): RecordIntegrationInstances<MqttHaConnectionBody> {
  return new RecordIntegrationInstances<MqttHaConnectionBody>(records, mqttHaConnectionsEntryKind, {
    description: {
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'connection',
      canTest: false,
    },
    formSchema: () => buildMqttHaConnectionForm(),
    initialBody: (name): MqttHaConnectionBody => ({ name }),
    configured: (body) => body.mqttBrokerId !== undefined,
    onChanged: async (_id, change) => {
      if (change !== 'deleted') await deps.onChanged()
    },
  })
}
