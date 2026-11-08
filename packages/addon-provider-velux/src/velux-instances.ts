/**
 * Velux integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the connection to ONE KLF-200 gateway. The
 * gateway password is declared a secret by type; the records door keeps it in the keychain.
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
  type VeluxConnectionConfig,
} from './config.js'

export const veluxConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Velux gateways',
  schema: entryBody({
    host: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
  }),
  writeTrigger: 'an operator adds, edits or removes a Velux KLF-200 gateway integration',
})
export type VeluxConnectionBody = z.infer<typeof veluxConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const veluxRecordKinds = { connections: veluxConnectionsEntryKind } as const

export function buildVeluxInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: {
    readonly onChanged: () => Promise<void>
    readonly tester: Pick<IConnectionProbe, 'testSettings'>
  },
): RecordIntegrationInstances<VeluxConnectionBody> {
  const handle = records.kind(veluxConnectionsEntryKind)
  return new RecordIntegrationInstances<VeluxConnectionBody>(records, veluxConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'server',
      canTest: true,
      kinds: [
        { id: 'connection', label: 'Velux', functionCap: 'device-provider', role: 'devices' },
      ],
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): VeluxConnectionBody => ({ name }),
    configured: (body) => (body.host ?? '').length > 0 && body.password !== undefined,
    onChanged: () => deps.onChanged(),
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      // The stored gateway under the edited form; a saved password is never retyped, the form
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
 * The gateway connection of one integration as the addon's runtime reads it: from the record,
 * never from the legacy rows. Null while the record is absent, incomplete, or its password is
 * unreadable (the runtime keeps what it had, D49).
 */
export async function veluxConnectionOf(
  instances: Pick<RecordIntegrationInstances<VeluxConnectionBody>, 'readResolved'>,
  id: string,
): Promise<VeluxConnectionConfig | null> {
  const read = await instances.readResolved(id)
  if (read === null || read.secrets === 'unavailable') return null
  return connectionFromSettings(read.body)
}
