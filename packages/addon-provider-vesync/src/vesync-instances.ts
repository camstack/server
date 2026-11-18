/**
 * VeSync integrations as `integration-instances` (planning#416, D1007): one `connections`
 * record per integration under its registry id, holding the credentials of ONE VeSync
 * account. The password is declared a secret by type; the records door keeps it in the
 * keychain.
 */
import {
  defineEntryKind,
  entryBody,
  type IntegrationTestConnectionResult,
  REDACTED_SECRET,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import { z } from 'zod'
import {
  buildConnectionFormSchema,
  connectionFromBody,
  type VeSyncConnectionConfig,
  vesyncConnectionSchema,
  vesyncCountryCodeSchema,
} from './config.js'
import type { VeSyncClientFactory } from './vesync-client-contract.js'
import { testVeSyncConnection } from './vesync-connection-test.js'
import { tsVeSyncClientFactory } from './vesync-tsvesync-client.js'

export const vesyncConnectionsEntryKind = defineEntryKind('connections', {
  title: 'VeSync accounts',
  schema: entryBody({
    email: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    region: z.enum(['US', 'EU']).optional(),
    countryCode: vesyncCountryCodeSchema,
    pollIntervalMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a VeSync account integration',
})
export type VeSyncConnectionBody = z.infer<typeof vesyncConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const vesyncRecordKinds = { connections: vesyncConnectionsEntryKind } as const

export function buildVeSyncInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: {
    readonly onChanged: () => Promise<void>
    /** The client factory the test signs in with (the same one the runtime polls with). */
    readonly makeClient?: VeSyncClientFactory
  },
): RecordIntegrationInstances<VeSyncConnectionBody> {
  const handle = records.kind(vesyncConnectionsEntryKind)
  const makeClient = deps.makeClient ?? tsVeSyncClientFactory
  return new RecordIntegrationInstances<VeSyncConnectionBody>(records, vesyncConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      kinds: [
        { id: 'connection', label: 'VeSync', functionCap: 'device-provider', role: 'devices' },
      ],
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): VeSyncConnectionBody => ({ name }),
    addDevice: () => 'children',
    configured: (body) => (body.email ?? '').length > 0 && body.password !== undefined,
    onChanged: () => deps.onChanged(),
    // The country code is checked at save (the record layer stores what it is handed): a stored
    // bad code would fail `connectionFromBody` and drop a working account at reconcile.
    validateWrite: ({ body }) => {
      const parsed = vesyncCountryCodeSchema.safeParse(body['countryCode'])
      if (!parsed.success) {
        throw new Error(`vesync: Country code — ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      }
      return parsed.data === undefined ? undefined : { countryCode: parsed.data }
    },
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      // The stored account under the edited form; a saved password is never retyped, the form
      // hands back its redacted view, so the keychain value stands in.
      const stored = id === null ? null : ((await handle.getResolved(id))?.data ?? null)
      const typed = values['password']
      const password =
        typeof typed === 'string' && typed !== '' && typed !== REDACTED_SECRET
          ? typed
          : (stored?.password ?? '')
      if (typeof password !== 'string') {
        return {
          success: false,
          status: 'inconclusive',
          error: 'vesync: the stored password cannot be read right now (keychain unavailable)',
        }
      }
      const parsed = vesyncConnectionSchema.safeParse({ ...stored, ...values, password })
      if (!parsed.success) {
        return { success: false, status: 'rejected', error: refusalOf(parsed.error) }
      }
      return testVeSyncConnection(parsed.data, makeClient)
    },
  })
}

/** The form refusal a failed parse means: the field Zod named, in its own words. */
function refusalOf(error: z.ZodError): string {
  const issue = error.issues[0]
  const field = issue?.path.join('.') ?? ''
  if (issue === undefined || field === 'email') return 'vesync: enter the account email'
  if (field === 'countryCode') return `vesync: Country code — ${issue.message}`
  return `vesync: ${field} — ${issue.message}`
}

/** What the runtime reads for one integration. `passwordLocked` keeps the previous client (D49). */
export interface VeSyncAccountRead {
  readonly connection: VeSyncConnectionConfig | null
  readonly passwordLocked: boolean
}

/**
 * The account of one integration as the runtime reads it: from the record. Null while the record is absent or holds no email and password.
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
