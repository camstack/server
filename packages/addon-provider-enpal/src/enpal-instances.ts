/**
 * Enpal integrations as `integration-instances` (planning#416, D1007): one `connections` record
 * per integration under its registry id, holding the connection to ONE Enpal box. The InfluxDB
 * token is declared a secret by type; the records door keeps it in the keychain. The Gateway
 * device is not part of the record: it is a device of the integration, adopted from it.
 */
import {
  defineEntryKind,
  entryBody,
  type IntegrationTestConnectionResult,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import { z } from 'zod'
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  type EnpalConnection,
  enpalConnectionSchema,
  ENPAL_SOURCES,
  type EnpalConnectionRead,
} from './config.js'
import { EnpalError, readEnpalSnapshot } from './enpal-client.js'
import type { BlazorReader } from './enpal-blazor.js'
import type { EnpalErrorKind, EnpalSnapshot } from './enpal-snapshot.js'

export const enpalConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Enpal integrations',
  schema: entryBody({
    host: z.string().optional(),
    source: z.enum(ENPAL_SOURCES).optional(),
    influxPort: z.number().optional(),
    org: z.string().optional(),
    bucket: z.string().optional(),
    token: z.string().optional().meta({ secret: true }),
    pagePort: z.number().optional(),
    pollIntervalMs: z.number().optional(),
    invertBatteryPower: z.boolean().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes an Enpal box integration',
})
export type EnpalConnectionBody = z.infer<typeof enpalConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const enpalRecordKinds = { connections: enpalConnectionsEntryKind } as const

export interface EnpalInstancesDeps {
  readonly onChanged: () => Promise<void>
  /** The box's Blazor bridge, read when a test runs (it may not exist at construction). */
  readonly blazor?: () => BlazorReader | undefined
  /** Replaces the live box read. Specs pass this so a test never dials the network. */
  readonly probe?: (connection: EnpalConnection) => Promise<EnpalSnapshot>
}

const REJECTED_KINDS: ReadonlySet<EnpalErrorKind> = new Set([
  'unauthorized',
  'token-missing',
  'empty',
])

function connectionForTest(values: Readonly<Record<string, unknown>>): EnpalConnection | null {
  const host = values['host']
  if (typeof host !== 'string' || host.trim().length === 0) return null
  const parsed = enpalConnectionSchema.safeParse({ ...values })
  return parsed.success ? parsed.data : null
}

function testFailure(error: unknown): IntegrationTestConnectionResult {
  if (error instanceof EnpalError) {
    return {
      success: false,
      status: REJECTED_KINDS.has(error.kind) ? 'rejected' : 'inconclusive',
      error: error.message,
    }
  }
  return { success: false, status: 'inconclusive', error: 'The Enpal box did not answer' }
}

function liveProbe(
  blazor: (() => BlazorReader | undefined) | undefined,
): (connection: EnpalConnection) => Promise<EnpalSnapshot> {
  return (connection) =>
    readEnpalSnapshot({
      connection,
      fetch: globalThis.fetch,
      now: () => Date.now(),
      blazor: blazor?.(),
    })
}

export function buildEnpalInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: EnpalInstancesDeps,
): RecordIntegrationInstances<EnpalConnectionBody> {
  const probe = deps.probe ?? liveProbe(deps.blazor)
  return new RecordIntegrationInstances<EnpalConnectionBody>(records, enpalConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'account', scopedToInstance: true },
      instanceMode: 'multiple',
      kind: 'server',
      canTest: true,
      kinds: [
        {
          id: 'connection',
          label: 'Enpal',
          functionCap: 'device-provider',
          role: 'devices',
          canTest: true,
        },
      ],
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): EnpalConnectionBody => ({ name }),
    configured: (body) => (body.host ?? '').length > 0,
    onChanged: () => deps.onChanged(),
    test: async ({ values }): Promise<IntegrationTestConnectionResult> => {
      const connection = connectionForTest(values)
      if (connection === null) {
        return { success: false, status: 'rejected', error: 'Host is required' }
      }
      try {
        await probe(connection)
        return { success: true, status: 'validated' }
      } catch (error) {
        return testFailure(error)
      }
    },
  })
}

/**
 * The connection of one integration as the addon's runtime reads it: from the record, never from
 * the legacy rows. Null while the record is absent or holds no host; `tokenLocked` while the
 * keychain refuses the token (the runtime keeps what it had, D49).
 */
export async function enpalConnectionOf(
  instances: Pick<RecordIntegrationInstances<EnpalConnectionBody>, 'readResolved'>,
  id: string,
): Promise<EnpalConnectionRead | null> {
  const read = await instances.readResolved(id)
  return read === null ? null : connectionFromSettings(read.body, read.secrets === 'unavailable')
}
