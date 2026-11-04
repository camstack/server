/**
 * Tuya integrations as `integration-instances` (planning#416, D1007): one `connections` record per
 * integration under its registry id, holding the Tuya IoT project the account is read through.
 * The Access Secret is declared a secret by type; the records door keeps it in the keychain.
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
  type TuyaConfig,
  TuyaRegionSchema,
} from './config.js'

export const tuyaConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Tuya integrations',
  schema: entryBody({
    accessId: z.string().optional(),
    accessSecret: z.string().optional().meta({ secret: true }),
    region: TuyaRegionSchema.optional(),
    discoveryTimeoutMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a Tuya account integration',
})
export type TuyaConnectionBody = z.infer<typeof tuyaConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const tuyaRecordKinds = { connections: tuyaConnectionsEntryKind } as const

export function buildTuyaInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: { readonly onChanged: () => Promise<void> },
): RecordIntegrationInstances<TuyaConnectionBody> {
  return new RecordIntegrationInstances<TuyaConnectionBody>(records, tuyaConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'account',
      canTest: false,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): TuyaConnectionBody => ({ name }),
    configured: (body) => (body.accessId ?? '').length > 0 && body.accessSecret !== undefined,
    onChanged: () => deps.onChanged(),
  })
}

/**
 * The connection of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent or holds no complete credentials.
 */
export async function tuyaConnectionOf(
  instances: Pick<RecordIntegrationInstances<TuyaConnectionBody>, 'getResolved'>,
  id: string,
): Promise<TuyaConfig | null> {
  const body = await instances.getResolved(id)
  return body === null ? null : connectionFromSettings(body)
}
