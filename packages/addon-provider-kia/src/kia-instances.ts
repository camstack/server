/**
 * Kia integrations as `integration-instances` (planning#416, D1007): one `connections` record
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
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  KiaBrandSchema,
  KiaRegionSchema,
} from './config.js'
import type { KiaConfig } from './config.js'

export const kiaConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Kia accounts',
  schema: entryBody({
    username: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    pin: z.string().optional().meta({ secret: true }),
    region: KiaRegionSchema.optional(),
    brand: KiaBrandSchema.optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a Kia account integration',
})
export type KiaConnectionBody = z.infer<typeof kiaConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const kiaRecordKinds = { connections: kiaConnectionsEntryKind } as const

export function buildKiaInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: {
    readonly onChanged: () => Promise<void>
    readonly tester: Pick<IConnectionProbe, 'testSettings'>
  },
): RecordIntegrationInstances<KiaConnectionBody> {
  const handle = records.kind(kiaConnectionsEntryKind)
  return new RecordIntegrationInstances<KiaConnectionBody>(records, kiaConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      kinds: [{ id: 'connection', label: 'Kia', functionCap: 'device-provider', role: 'devices' }],
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): KiaConnectionBody => ({ name }),
    addDevice: () => 'children',
    configured: (body) =>
      (body.username ?? '').length > 0 && body.password !== undefined && body.pin !== undefined,
    onChanged: () => deps.onChanged(),
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      // The stored account under the edited form; a saved password is never retyped, the form
      // hands back its redacted view, so the keychain value stands in.
      const stored = id === null ? null : ((await handle.getResolved(id))?.data ?? null)
      const password = typedSecret(values['password'], stored?.password)
      const pin = typedSecret(values['pin'], stored?.pin)
      const outcome = await deps.tester.testSettings({
        settings: { ...stored, ...values, password, pin },
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

/** A secret typed in the form, or the stored one when the form handed back its redacted view. */
function typedSecret(typed: unknown, stored: string | undefined): string {
  return typeof typed === 'string' && typed !== '' && typed !== REDACTED_SECRET
    ? typed
    : (stored ?? '')
}

/**
 * The account of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent, incomplete, or its password is unreadable
 * (the runtime keeps what it had, D49).
 */
export async function kiaConnectionOf(
  instances: Pick<RecordIntegrationInstances<KiaConnectionBody>, 'readResolved'>,
  id: string,
): Promise<KiaConfig | null> {
  const read = await instances.readResolved(id)
  if (read === null || read.secrets === 'unavailable') return null
  return connectionFromSettings(read.body)
}
