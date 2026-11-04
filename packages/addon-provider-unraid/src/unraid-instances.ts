/**
 * Unraid integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the connection to ONE Unraid server. The API key
 * is declared a secret by type; the records door keeps it in the keychain. The Gateway device is
 * not part of the record: it is a device of the integration, adopted from it.
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
  type UnraidConnectionRead,
} from './config.js'

export const unraidConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Unraid integrations',
  schema: entryBody({
    host: z.string().optional(),
    port: z.number().optional(),
    https: z.boolean().optional(),
    allowSelfSigned: z.boolean().optional(),
    apiKey: z.string().optional().meta({ secret: true }),
    pollIntervalMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes an Unraid server integration',
})
export type UnraidConnectionBody = z.infer<typeof unraidConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const unraidRecordKinds = { connections: unraidConnectionsEntryKind } as const

export function buildUnraidInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: { readonly onChanged: () => Promise<void> },
): RecordIntegrationInstances<UnraidConnectionBody> {
  return new RecordIntegrationInstances<UnraidConnectionBody>(records, unraidConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'server',
      canTest: false,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): UnraidConnectionBody => ({ name }),
    configured: (body) => (body.host ?? '').length > 0 && body.apiKey !== undefined,
    onChanged: () => deps.onChanged(),
  })
}

/**
 * The connection of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent or holds no host; `apiKeyLocked` while the
 * keychain refuses the key (the runtime keeps what it had, D49).
 */
export async function unraidConnectionOf(
  instances: Pick<RecordIntegrationInstances<UnraidConnectionBody>, 'readResolved'>,
  id: string,
): Promise<UnraidConnectionRead | null> {
  const read = await instances.readResolved(id)
  return read === null ? null : connectionFromSettings(read.body, read.secrets === 'unavailable')
}
