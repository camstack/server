/**
 * UniFi integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the connection to ONE controller. The API key
 * and the password are declared secrets by type; the records door keeps them in the keychain.
 * The Gateway device is not part of the record: it is a device of the integration.
 */
import {
  defineEntryKind,
  entryBody,
  type IntegrationInstanceStatus,
  type IntegrationTestConnectionResult,
  REDACTED_SECRET,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import { z } from 'zod'
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  unifiConnectionSchema,
  type UnifiConnectionRead,
} from './config.js'
import type { UnifiControllerClientFactory } from './unifi-client-contract.js'
import { testUnifiConnection } from './unifi-connection-test.js'

export const unifiConnectionsEntryKind = defineEntryKind('connections', {
  title: 'UniFi integrations',
  schema: entryBody({
    host: z.string().optional(),
    port: z.number().optional(),
    apiKey: z.string().optional().meta({ secret: true }),
    username: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    site: z.string().optional(),
    allowSelfSigned: z.boolean().optional(),
    pollIntervalMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a UniFi controller integration',
})
export type UnifiConnectionBody = z.infer<typeof unifiConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const unifiRecordKinds = {
  connections: unifiConnectionsEntryKind,
} as const

/** What the instances need from the running addon. */
export interface UnifiInstancesDeps {
  readonly onChanged: () => Promise<void>
  /** The client factory the test signs in with (the same one the runtime polls with). */
  readonly makeClient: UnifiControllerClientFactory
  /** The live state of an integration's connection, for its status word; null when not running. */
  readonly statusOf: (id: string) => IntegrationInstanceStatus | null
}

/** The secret the test signs in with; the password is not used yet (planning#581). */
const SECRET_KEYS = ['apiKey'] as const

/**
 * The connection the test signs in with: the stored record under the edited form. A saved secret
 * is never retyped (the form hands back its redacted view), so the keychain value stands in.
 */
function testedSettings(
  stored: Readonly<Record<string, unknown>> | null,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored, ...values }
  for (const key of SECRET_KEYS) {
    const typed = values[key]
    const keepStored = typed === undefined || typed === '' || typed === REDACTED_SECRET
    merged[key] = keepStored ? (stored?.[key] ?? '') : typed
  }
  return merged
}

export function buildUnifiInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: UnifiInstancesDeps,
): RecordIntegrationInstances<UnifiConnectionBody> {
  const handle = records.kind(unifiConnectionsEntryKind)
  return new RecordIntegrationInstances<UnifiConnectionBody>(records, unifiConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'server',
      canTest: true,
      kinds: [
        {
          id: 'connection',
          label: 'UniFi Network',
          functionCap: 'device-provider',
          role: 'devices',
        },
      ],
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): UnifiConnectionBody => ({ name }),
    configured: (body) =>
      (body.host ?? '').length > 0 &&
      (body.apiKey !== undefined || (body.username ?? '').length > 0),
    health: (_body, id) => {
      const status = deps.statusOf(id)
      return status === null ? {} : { status }
    },
    onChanged: () => deps.onChanged(),
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      const stored = id === null ? null : ((await handle.getResolved(id))?.data ?? null)
      const settings = testedSettings(stored, values)
      if (SECRET_KEYS.some((key) => typeof settings[key] !== 'string')) {
        // Locked is never empty: a stored secret the keychain cannot serve is not a blank one.
        return {
          success: false,
          status: 'inconclusive',
          error: 'unifi: the stored credential cannot be read right now (keychain unavailable)',
        }
      }
      const parsed = unifiConnectionSchema.safeParse(settings)
      if (!parsed.success) {
        return {
          success: false,
          status: 'rejected',
          error: 'unifi: enter the controller host (and a valid port and poll interval)',
        }
      }
      return testUnifiConnection(parsed.data, deps.makeClient)
    },
  })
}

/**
 * The connection of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent or holds no host; `credentialsLocked` while
 * the keychain refuses a credential (the runtime keeps what it had, D49).
 */
export async function unifiConnectionOf(
  instances: Pick<RecordIntegrationInstances<UnifiConnectionBody>, 'readResolved'>,
  id: string,
): Promise<UnifiConnectionRead | null> {
  const read = await instances.readResolved(id)
  return read === null ? null : connectionFromSettings(read.body, read.secrets === 'unavailable')
}
