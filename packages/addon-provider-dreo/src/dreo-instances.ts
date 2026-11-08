/**
 * Dreo integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the credentials of ONE cloud account. The
 * password is declared a secret by type; the records door keeps it in the keychain.
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
  deps: {
    readonly onChanged: () => Promise<void>
    readonly tester: Pick<IConnectionProbe, 'testSettings'>
  },
): RecordIntegrationInstances<DreoConnectionBody> {
  const handle = records.kind(dreoConnectionsEntryKind)
  return new RecordIntegrationInstances<DreoConnectionBody>(records, dreoConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      kinds: [{ id: 'connection', label: 'Dreo', functionCap: 'device-provider', role: 'devices' }],
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): DreoConnectionBody => ({ name }),
    configured: (body) => (body.email ?? '').length > 0 && body.password !== undefined,
    onChanged: () => deps.onChanged(),
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      // The stored account under the edited form; a saved password is never retyped, the form
      // hands back its redacted view, so the keychain value stands in.
      const stored = id === null ? null : ((await handle.getResolved(id))?.data ?? null)
      const typed = values['password']
      const password =
        typeof typed === 'string' && typed !== '' && typed !== REDACTED_SECRET
          ? typed
          : (stored?.password ?? '')
      const outcome = await deps.tester.testSettings({
        settings: { ...stored, ...values, password },
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
