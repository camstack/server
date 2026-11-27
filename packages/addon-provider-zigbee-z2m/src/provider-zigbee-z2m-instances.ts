/**
 * Zigbee2MQTT integrations as `integration-instances` (D1007): one `connections` record per
 * integration, keyed by the registry id, holding the connection to ONE Zigbee2MQTT system. The
 * token is a secret by TYPE; the records door keeps it in the keychain. The Gateway device is not
 * part of the record: it is a device OF the integration, adopted from it.
 */
import {
  type ConfigUISchema,
  defineEntryKind,
  entryBody,
  type IntegrationTestConnectionResult,
  RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { z } from 'zod'

export const Z2M_DEFAULT_PORT = 8080

export const ProviderZigbeeZ2mConnectionsKind = defineEntryKind('connections', {
  title: 'Zigbee2MQTT integrations',
  schema: entryBody({
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().optional(),
    /** The frontend `auth_token`, when the server asks for one; a secret by type, kept in the keychain. */
    token: z.string().optional().meta({ secret: true }),
  }),
  writeTrigger: 'an operator adds, edits or removes a Zigbee2MQTT integration',
})
export type ProviderZigbeeZ2mConnectionBody = z.infer<
  typeof ProviderZigbeeZ2mConnectionsKind.schema
>

/** Every record kind this addon declares, keyed by its name. */
export const ProviderZigbeeZ2mRecordKinds = {
  connections: ProviderZigbeeZ2mConnectionsKind,
} as const

export function buildProviderZigbeeZ2mConnectionForm(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        columns: 1,
        fields: [
          { type: 'text', key: 'name', label: 'Name' },
          { type: 'text', key: 'host', label: 'Host' },
          {
            type: 'number',
            key: 'port',
            label: 'Frontend port',
            default: Z2M_DEFAULT_PORT,
          },
          {
            type: 'boolean',
            key: 'tls',
            label: 'Use TLS (wss)',
            default: false,
          },
          {
            type: 'password',
            key: 'token',
            label: 'Auth token (optional)',
            showToggle: true,
          },
        ],
      },
    ],
  }
}

export interface ProviderZigbeeZ2mInstanceDeps {
  /** Re-apply the runtime from the records after a create, update, enable or delete. */
  readonly onChanged: () => Promise<void>
  /** Probe the remote with the (possibly unsaved) values; a failed probe is not a pass. */
  readonly probe: (
    values: Readonly<Record<string, unknown>>,
  ) => Promise<IntegrationTestConnectionResult>
}

export function buildProviderZigbeeZ2mInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: ProviderZigbeeZ2mInstanceDeps,
): RecordIntegrationInstances<ProviderZigbeeZ2mConnectionBody> {
  return new RecordIntegrationInstances<ProviderZigbeeZ2mConnectionBody>(
    records,
    ProviderZigbeeZ2mConnectionsKind,
    {
      description: {
        role: 'devices',
        discovery: { mode: 'account', scopedToInstance: true },
        instanceMode: 'multiple',
        kind: 'server',
        canTest: true,
        // The one kind this provider serves; its functionCap is the cap an instance of it feeds.
        kinds: [
          {
            id: 'server',
            label: 'Zigbee2MQTT',
            functionCap: 'device-provider',
            role: 'devices',
          },
        ],
      },
      formSchema: () => buildProviderZigbeeZ2mConnectionForm(),
      initialBody: (name): ProviderZigbeeZ2mConnectionBody => ({ name }),
      configured: (body) => (body.host ?? '').length > 0,
      onChanged: () => deps.onChanged(),
      test: ({ values }) => deps.probe(values),
    },
  )
}
