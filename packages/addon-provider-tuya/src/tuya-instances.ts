/**
 * Tuya integrations as `integration-instances` (planning#416, D1007): one `connections` record per
 * integration under its registry id, holding the Tuya IoT project the account is read through.
 * The Access Secret is declared a secret by type; the records door keeps it in the keychain.
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
  deps: {
    readonly onChanged: () => Promise<void>
    readonly tester: Pick<IConnectionProbe, 'testSettings'>
  },
): RecordIntegrationInstances<TuyaConnectionBody> {
  const handle = records.kind(tuyaConnectionsEntryKind)
  return new RecordIntegrationInstances<TuyaConnectionBody>(records, tuyaConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): TuyaConnectionBody => ({ name }),
    configured: (body) => (body.accessId ?? '').length > 0 && body.accessSecret !== undefined,
    onChanged: () => deps.onChanged(),
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      // The stored project under the edited form; a saved secret is never retyped, the form
      // hands back its redacted view, so the keychain value stands in.
      const stored = id === null ? null : ((await handle.getResolved(id))?.data ?? null)
      const typed = values['accessSecret']
      const accessSecret =
        typeof typed === 'string' && typed !== '' && typed !== REDACTED_SECRET
          ? typed
          : (stored?.accessSecret ?? '')
      const outcome = await deps.tester.testSettings({
        settings: { ...stored, ...values, accessSecret },
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
