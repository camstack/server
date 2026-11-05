/**
 * Dreo integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the credentials of ONE cloud account. The
 * password is declared a secret by type; the records door keeps it in the keychain.
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import { z } from 'zod'
import { buildConnectionFormSchema, connectionFromSettings, DreoRegionSchema } from './config.js'
import type { DreoConfig } from './config.js'

export const dreoConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Dreo accounts',
  schema: entryBody({
    email: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    region: DreoRegionSchema.optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a Dreo account integration',
})
export type DreoConnectionBody = z.infer<typeof dreoConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const dreoRecordKinds = { connections: dreoConnectionsEntryKind } as const

export function buildDreoInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: { readonly onChanged: () => Promise<void> },
): RecordIntegrationInstances<DreoConnectionBody> {
  return new RecordIntegrationInstances<DreoConnectionBody>(records, dreoConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): DreoConnectionBody => ({ name }),
    configured: (body) => (body.email ?? '').length > 0 && body.password !== undefined,
    onChanged: () => deps.onChanged(),
  })
}

/**
 * The account of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent, incomplete, or its password is unreadable
 * (the runtime keeps what it had, D49).
 */
export async function dreoConnectionOf(
  instances: Pick<RecordIntegrationInstances<DreoConnectionBody>, 'readResolved'>,
  id: string,
): Promise<DreoConfig | null> {
  const read = await instances.readResolved(id)
  if (read === null || read.secrets === 'unavailable') return null
  return connectionFromSettings(read.body)
}
