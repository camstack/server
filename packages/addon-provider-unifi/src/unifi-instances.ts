/**
 * UniFi integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the connection to ONE controller. The API key
 * and the password are declared secrets by type; the records door keeps them in the keychain.
 * The Gateway device is not part of the record: it is a device of the integration.
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
  type UnifiConnectionRead,
} from './config.js'

export const unifiConnectionsEntryKind = defineEntryKind('connections', {
  title: 'UniFi integrations',
  schema: entryBody({
    host: z.string().optional(),
    port: z.number().optional(),
    apiKey: z.string().optional().meta({ secret: true }),
    username: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    site: z.string().optional(),
    allowSelfSigned: z.boolean().optional(),
    pollIntervalMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a UniFi controller integration',
})
export type UnifiConnectionBody = z.infer<typeof unifiConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const unifiRecordKinds = { connections: unifiConnectionsEntryKind } as const

export function buildUnifiInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: { readonly onChanged: () => Promise<void> },
): RecordIntegrationInstances<UnifiConnectionBody> {
  return new RecordIntegrationInstances<UnifiConnectionBody>(records, unifiConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'server',
      canTest: false,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): UnifiConnectionBody => ({ name }),
    configured: (body) =>
      (body.host ?? '').length > 0 &&
      (body.apiKey !== undefined || (body.username ?? '').length > 0),
    onChanged: () => deps.onChanged(),
  })
}

/**
 * The connection of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent or holds no host; `credentialsLocked` while
 * the keychain refuses a credential (the runtime keeps what it had, D49).
 */
export async function unifiConnectionOf(
  instances: Pick<RecordIntegrationInstances<UnifiConnectionBody>, 'readResolved'>,
  id: string,
): Promise<UnifiConnectionRead | null> {
  const read = await instances.readResolved(id)
  return read === null ? null : connectionFromSettings(read.body, read.secrets === 'unavailable')
}
