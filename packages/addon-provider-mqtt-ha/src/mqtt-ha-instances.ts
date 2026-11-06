/**
 * MQTT Discovery integrations as `integration-instances` (planning#416, D985, D1007): one
 * `connections` record per integration under the `integrations` registry id. The body holds the
 * LINK to an MQTT broker, `mqttBrokerId`: the id of an `mqtt-broker` instance, never a copy of that
 * broker's host or credentials, which stay with the broker.
 */
import {
  type AddonMigration,
  type ConfigUISchema,
  declareLinkKind,
  type IntegrationRowsApi,
  type RowsRecordsDoor,
  type SecretsAccess,
  type IntegrationRowsPorts,
  integrationRowsPortsOverApi,
  linkFieldDescriptor,
  type MigrationProcedureResult,
  moveIntegrationRowsToRecords,
  RecordIntegrationInstances,
  type RecordsAccess,
  type RowsMigrationLog,
} from '@camstack/types'
import { z } from 'zod'

/** The one link of an integration: to an `mqtt` broker instance, REQUIRED (D1013); `''` while unlinked. */
export const MQTT_BROKER_LINK_FIELD = 'mqttBrokerId'

export const mqttHaConnectionsEntryKind = declareLinkKind({
  name: 'connections',
  title: 'MQTT Discovery integrations',
  links: { mqttBrokerId: { cap: 'broker', kind: 'mqtt' } },
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
            ...linkFieldDescriptor(
              MQTT_BROKER_LINK_FIELD,
              { cap: 'broker', kind: 'mqtt' },
              { label: 'MQTT broker' },
            ),
            labelKey: 'provider-mqtt-ha:globalSettings.s_mqtt-ha-broker-link.mqttBrokerId.label',
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
  return { name: integration.name, mqttBrokerId: mqttBrokerId ?? '' }
}

export const MQTT_HA_ROWS_TO_RECORD_ID = 'provider-mqtt-ha/2026-11-05-integration-rows-to-record'
export const MQTT_HA_LINK_REQUIRED_ID = 'provider-mqtt-ha/2026-11-07-mqtt-link-required'

/** What the link backfill found in one integration record. */
export type MqttLinkState = 'filled' | 'linked' | 'unlinked' | 'no-record'

/** The rows move's ports plus the one the link backfill needs. */
export interface MqttHaMigrationPorts extends IntegrationRowsPorts {
  /**
   * Give a record that has no `mqttBrokerId` key the empty link, keeping every other field, and
   * read it back. `linked` / `unlinked` say what an untouched record holds.
   */
  ensureLinkField(id: string): Promise<MqttLinkState>
}

/**
 * The link became a REQUIRED string (`''` while unlinked): a record written before that has no key.
 * Give it one; an integration with no broker stays unconfigured and is counted in a warning. Never
 * deletes, never invents a broker.
 */
export async function backfillMqttLinks(
  ports: MqttHaMigrationPorts,
): Promise<MigrationProcedureResult> {
  const integrations = await ports.listIntegrations('provider-mqtt-ha')
  const counts = { filled: 0, linked: 0, unlinked: 0, 'no-record': 0 }
  for (const integration of integrations) counts[await ports.ensureLinkField(integration.id)] += 1
  const unconfigured = counts.filled + counts.unlinked
  if (unconfigured > 0) {
    ports.warn(
      `${unconfigured} MQTT Discovery integration(s) link to no MQTT broker and stay unconfigured until one is picked`,
    )
  }
  return {
    outcome: counts.filled > 0 ? 'done' : 'already-done',
    summary: { ...counts },
  }
}

/** The whole `provider-mqtt-ha` catalogue (D987): offered to the engine at `onInitialize`. */
export const MQTT_HA_MIGRATIONS: readonly AddonMigration<MqttHaMigrationPorts>[] = [
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
  {
    meta: {
      id: MQTT_HA_LINK_REQUIRED_ID,
      owner: 'provider-mqtt-ha',
      level: 'addon-state',
      seq: 2,
      dependsOn: [MQTT_HA_ROWS_TO_RECORD_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'The broker link of an MQTT Discovery integration is a required instance link: give a record that has no `mqttBrokerId` key the empty link, and warn about the integrations that link to no broker',
      fixtureMark: 'a record field the migration does not know',
    },
    procedure: (ports) => backfillMqttLinks(ports),
  },
]

/** The hub side and the records side of the move, over `ctx.api` and `ctx.records`. */
export function mqttHaRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: RowsRecordsDoor
  readonly warn: (message: string) => void
  readonly secrets?: Pick<SecretsAccess, 'resolve' | 'delete'> | null
}): MqttHaMigrationPorts {
  const handle = deps.records.kind({
    name: mqttHaConnectionsEntryKind.name,
    declaration: mqttHaConnectionsEntryKind.declaration,
    schema: z.record(z.string(), z.unknown()),
  })
  const base = integrationRowsPortsOverApi({
    api: deps.api,
    ...(deps.secrets !== undefined ? { secrets: deps.secrets } : {}),
    records: handle,
    log: { warn: deps.warn },
  })
  return {
    ...base,
    ensureLinkField: async (id) => {
      const stored = await handle.get(id)
      if (stored === null) return 'no-record'
      const current = stored.data[MQTT_BROKER_LINK_FIELD]
      if (typeof current === 'string') return current === '' ? 'unlinked' : 'linked'
      await handle.put({ id, data: { ...stored.data, [MQTT_BROKER_LINK_FIELD]: '' } })
      const back = await handle.get(id)
      if (typeof back?.data[MQTT_BROKER_LINK_FIELD] !== 'string') {
        throw new Error(`integration '${id}': the link field did not read back after the write`)
      }
      return 'filled'
    },
  }
}

/** The broker an integration links to, from its record; undefined while it links to none. */
export async function mqttHaBrokerIdOf(
  instances: Pick<RecordIntegrationInstances<MqttHaConnectionBody>, 'getResolved'>,
  id: string,
): Promise<string | undefined> {
  const linked = (await instances.getResolved(id))?.mqttBrokerId
  return linked === undefined || linked === '' ? undefined : linked
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
    initialBody: (name): MqttHaConnectionBody => ({ name, mqttBrokerId: '' }),
    configured: (body) => body.mqttBrokerId !== '',
    onChanged: async (_id, change) => {
      if (change !== 'deleted') await deps.onChanged()
    },
  })
}
