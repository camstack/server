/**
 * Enpal integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the connection to ONE Enpal box. The InfluxDB
 * token is declared a secret by type; the records door keeps it in the keychain. The Gateway
 * device is not part of the record: it is a device of the integration, adopted from it.
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import { z } from 'zod'
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  ENPAL_SOURCES,
  type EnpalConnectionRead,
} from './config.js'

export const enpalConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Enpal integrations',
  schema: entryBody({
    host: z.string().optional(),
    source: z.enum(ENPAL_SOURCES).optional(),
    influxPort: z.number().optional(),
    org: z.string().optional(),
    bucket: z.string().optional(),
    token: z.string().optional().meta({ secret: true }),
    pagePort: z.number().optional(),
    pollIntervalMs: z.number().optional(),
    invertBatteryPower: z.boolean().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes an Enpal box integration',
})
export type EnpalConnectionBody = z.infer<typeof enpalConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const enpalRecordKinds = { connections: enpalConnectionsEntryKind } as const

export function buildEnpalInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: { readonly onChanged: () => Promise<void> },
): RecordIntegrationInstances<EnpalConnectionBody> {
  return new RecordIntegrationInstances<EnpalConnectionBody>(records, enpalConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'server',
      canTest: false,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): EnpalConnectionBody => ({ name }),
    configured: (body) => (body.host ?? '').length > 0,
    onChanged: () => deps.onChanged(),
  })
}

/**
 * The connection of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent or holds no host; `tokenLocked` while the
 * keychain refuses the token (the runtime keeps what it had, D49).
 */
export async function enpalConnectionOf(
  instances: Pick<RecordIntegrationInstances<EnpalConnectionBody>, 'readResolved'>,
  id: string,
): Promise<EnpalConnectionRead | null> {
  const read = await instances.readResolved(id)
  return read === null ? null : connectionFromSettings(read.body, read.secrets === 'unavailable')
}
