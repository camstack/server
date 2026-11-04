/**
 * VeSync integrations as `integration-instances` (planning#416, D1007): one `connections`
 * record per integration under its registry id, holding the credentials of ONE VeSync
 * account. The password is declared a secret by type; the records door keeps it in the
 * keychain. The Gateway device is not part of the record: it is a device of the integration.
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
  connectionFromBody,
  type VeSyncConnectionConfig,
} from './config.js'

export const vesyncConnectionsEntryKind = defineEntryKind('connections', {
  title: 'VeSync accounts',
  schema: entryBody({
    email: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    region: z.enum(['US', 'EU']).optional(),
    pollIntervalMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a VeSync account integration',
})
export type VeSyncConnectionBody = z.infer<typeof vesyncConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const vesyncRecordKinds = { connections: vesyncConnectionsEntryKind } as const

export function buildVeSyncInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: { readonly onChanged: () => Promise<void> },
): RecordIntegrationInstances<VeSyncConnectionBody> {
  return new RecordIntegrationInstances<VeSyncConnectionBody>(records, vesyncConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'account',
      canTest: false,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): VeSyncConnectionBody => ({ name }),
    configured: (body) => (body.email ?? '').length > 0 && body.password !== undefined,
    onChanged: () => deps.onChanged(),
  })
}

/** What the runtime reads for one integration. `passwordLocked` keeps the previous client (D49). */
export interface VeSyncAccountRead {
  readonly connection: VeSyncConnectionConfig | null
  readonly passwordLocked: boolean
}

/**
 * The account of one integration as the runtime reads it: from the record, never from a
 * hub device. Null while the record is absent or holds no email and password.
 */
export async function vesyncConnectionOf(
  instances: Pick<RecordIntegrationInstances<VeSyncConnectionBody>, 'readResolved'>,
  id: string,
): Promise<VeSyncAccountRead | null> {
  const read = await instances.readResolved(id)
  if (read === null) return null
  if (read.secrets === 'unavailable') return { connection: null, passwordLocked: true }
  const connection = connectionFromBody(read.body)
  if (connection === null) return null
  return { connection, passwordLocked: false }
}
