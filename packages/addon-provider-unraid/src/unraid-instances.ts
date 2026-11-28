/**
 * Unraid integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the connection to ONE Unraid server. The API key
 * is declared a secret by type; the records door keeps it in the keychain. The server's Host
 * device is not part of the record: it is a device of the integration, adopted from it.
 */
import {
  defineEntryKind,
  entryBody,
  type IntegrationTestConnectionResult,
  REDACTED_SECRET,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@dominevo/types'
import { z } from 'zod'
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  unraidConnectionSchema,
  type UnraidConnectionRead,
} from './config.js'
import type { UnraidClientFactory } from './unraid-client-contract.js'
import { testUnraidConnection } from './unraid-connection-test.js'

export const unraidConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Unraid integrations',
  schema: entryBody({
    host: z.string().optional(),
    port: z.number().optional(),
    https: z.boolean().optional(),
    allowSelfSigned: z.boolean().optional(),
    apiKey: z.string().optional().meta({ secret: true }),
    pollIntervalMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes an Unraid server integration',
})
export type UnraidConnectionBody = z.infer<typeof unraidConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const unraidRecordKinds = {
  connections: unraidConnectionsEntryKind,
} as const

export function buildUnraidInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: {
    readonly onChanged: () => Promise<void>
    /** The client factory the test signs in with (the same one the runtime polls with). */
    readonly makeClient: UnraidClientFactory
  },
): RecordIntegrationInstances<UnraidConnectionBody> {
  const handle = records.kind(unraidConnectionsEntryKind)
  return new RecordIntegrationInstances<UnraidConnectionBody>(records, unraidConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'server',
      canTest: true,
      kinds: [
        {
          id: 'connection',
          label: 'Unraid',
          functionCap: 'device-provider',
          role: 'devices',
        },
      ],
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): UnraidConnectionBody => ({ name }),
    addDevice: () => 'children',
    configured: (body) => (body.host ?? '').length > 0 && body.apiKey !== undefined,
    onChanged: () => deps.onChanged(),
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      // The stored server under the edited form; a saved key is never retyped, the form hands
      // back its redacted view, so the keychain value stands in.
      const stored = id === null ? null : ((await handle.getResolved(id))?.data ?? null)
      const typed = values['apiKey']
      const apiKey =
        typeof typed === 'string' && typed !== '' && typed !== REDACTED_SECRET
          ? typed
          : (stored?.apiKey ?? '')
      if (typeof apiKey !== 'string') {
        return {
          success: false,
          status: 'inconclusive',
          error: 'unraid: the stored API key cannot be read right now (keychain unavailable)',
        }
      }
      const parsed = unraidConnectionSchema.safeParse({
        ...stored,
        ...values,
        apiKey,
      })
      if (!parsed.success) {
        return {
          success: false,
          status: 'rejected',
          error: 'unraid: enter the server host',
        }
      }
      return testUnraidConnection(parsed.data, deps.makeClient)
    },
  })
}

/**
 * The connection of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent or holds no host; `apiKeyLocked` while the
 * keychain refuses the key (the runtime keeps what it had, D49).
 */
export async function unraidConnectionOf(
  instances: Pick<RecordIntegrationInstances<UnraidConnectionBody>, 'readResolved'>,
  id: string,
): Promise<UnraidConnectionRead | null> {
  const read = await instances.readResolved(id)
  return read === null ? null : connectionFromSettings(read.body, read.secrets === 'unavailable')
}
