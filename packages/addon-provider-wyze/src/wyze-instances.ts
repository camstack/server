/**
 * Wyze integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the credentials of ONE Wyze account. The
 * password and the developer API key are declared secrets by type; the records door keeps them
 * in the keychain.
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import { z } from 'zod'
import type { WyzeCredentials } from './cloud-client.js'
import { buildSettingsSchema } from './settings-schema.js'

export const wyzeConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Wyze accounts',
  schema: entryBody({
    email: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    apiKey: z.string().optional().meta({ secret: true }),
    apiId: z.string().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a Wyze account integration',
})
export type WyzeConnectionBody = z.infer<typeof wyzeConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const wyzeRecordKinds = { connections: wyzeConnectionsEntryKind } as const

/** The four values a Wyze cloud login needs, or null while one is missing. */
export function credentialsFromBody(body: WyzeConnectionBody): WyzeCredentials | null {
  const email = (body.email ?? '').trim()
  const password = body.password ?? ''
  const apiKey = (body.apiKey ?? '').trim()
  const apiId = (body.apiId ?? '').trim()
  if (!email || !password || !apiKey || !apiId) return null
  return { email, password, apiKey, apiId }
}

export function buildWyzeInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: { readonly onChanged: () => Promise<void> },
): RecordIntegrationInstances<WyzeConnectionBody> {
  return new RecordIntegrationInstances<WyzeConnectionBody>(records, wyzeConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'account',
      canTest: false,
    },
    formSchema: () => buildSettingsSchema(),
    initialBody: (name): WyzeConnectionBody => ({ name }),
    configured: (body) =>
      (body.email ?? '').length > 0 && body.password !== undefined && body.apiKey !== undefined,
    onChanged: () => deps.onChanged(),
  })
}

/**
 * The account of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent, incomplete, or a secret is unreadable (the
 * runtime keeps what it had, D49).
 */
export async function wyzeCredentialsOf(
  instances: Pick<RecordIntegrationInstances<WyzeConnectionBody>, 'readResolved'>,
  id: string,
): Promise<WyzeCredentials | null> {
  const read = await instances.readResolved(id)
  if (read === null || read.secrets === 'unavailable') return null
  return credentialsFromBody(read.body)
}
