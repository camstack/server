/**
 * Wyze integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the credentials of ONE Wyze account. The
 * password and the developer API key are declared secrets by type; the records door keeps them
 * in the keychain.
 */
import {
  defineEntryKind,
  entryBody,
  type IConnectionProbe,
  type IntegrationTestConnectionResult,
  REDACTED_SECRET,
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
  deps: {
    readonly onChanged: () => Promise<void>
    readonly tester: Pick<IConnectionProbe, 'testSettings'>
  },
): RecordIntegrationInstances<WyzeConnectionBody> {
  const handle = records.kind(wyzeConnectionsEntryKind)
  return new RecordIntegrationInstances<WyzeConnectionBody>(records, wyzeConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      kinds: [{ id: 'connection', label: 'Wyze', functionCap: 'device-provider', role: 'devices' }],
    },
    formSchema: () => buildSettingsSchema(),
    initialBody: (name): WyzeConnectionBody => ({ name }),
    configured: (body) =>
      (body.email ?? '').length > 0 && body.password !== undefined && body.apiKey !== undefined,
    onChanged: () => deps.onChanged(),
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      // The stored account under the edited form; a saved password or API key is never retyped,
      // the form hands back its redacted view, so the keychain value stands in.
      const stored = id === null ? null : ((await handle.getResolved(id))?.data ?? null)
      const retyped = (key: 'password' | 'apiKey'): string => {
        const typed = values[key]
        return typeof typed === 'string' && typed !== '' && typed !== REDACTED_SECRET
          ? typed
          : (stored?.[key] ?? '')
      }
      const outcome = await deps.tester.testSettings({
        settings: {
          ...stored,
          ...values,
          password: retyped('password'),
          apiKey: retyped('apiKey'),
        },
      })
      if (outcome.outcome === 'validated') {
        return {
          success: true,
          status: 'validated',
          ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        }
      }
      return { success: false, status: outcome.outcome, error: outcome.error }
    },
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
