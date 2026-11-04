/**
 * Bosch Smart Home Controller integrations as `integration-instances` (planning#416, D985,
 * D1007): one `connections` record per controller under the `integrations` registry id. The body
 * IS the connection (host, the client certificate and key and the optional token, all three in
 * the keychain), so the form the instances page edits is the stored shape.
 */
import {
  type AddonMigration,
  defineEntryKind,
  entryBody,
  type IConnectionTestProvider,
  type IntegrationRowsApi,
  type IntegrationRowsPorts,
  RecordIntegrationInstances,
  type RecordsAccess,
  type RowsMigrationLog,
} from '@camstack/types'
import { z } from 'zod'
import {
  boschRowsMigration,
  boschRowsPorts,
  keepBodyKeys,
  testBoschInstance,
} from '../shared/bosch-instances.js'
import { buildConnectionFormSchema, connectionFromSettings, type ShcConfig } from './config.js'

export const shcConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Smart Home Controllers',
  schema: entryBody({
    host: z.string().optional(),
    sslCertificate: z.string().optional().meta({ secret: true }),
    sslKey: z.string().optional().meta({ secret: true }),
    token: z.string().optional().meta({ secret: true }),
  }),
  writeTrigger: 'an operator pairs, edits or removes a Smart Home Controller',
})
export type ShcConnectionBody = z.infer<typeof shcConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const shcRecordKinds = { connections: shcConnectionsEntryKind } as const

const LEGACY_KEYS: readonly string[] = ['host', 'sslCertificate', 'sslKey', 'token']
const SECRET_KEYS: readonly string[] = ['sslCertificate', 'sslKey', 'token']

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The record body of one controller, from its legacy rows (secrets resolved). */
export function shcBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: { readonly id: string; readonly name: string },
): ShcConnectionBody {
  const dropped = Object.keys(values).filter((key) => !LEGACY_KEYS.includes(key))
  if (dropped.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${dropped.join(', ')}`,
    )
  }
  const host = text(values['host'])
  const sslCertificate = text(values['sslCertificate'])
  const sslKey = text(values['sslKey'])
  const token = text(values['token'])
  return {
    name: integration.name,
    ...(host !== undefined ? { host } : {}),
    ...(sslCertificate !== undefined ? { sslCertificate } : {}),
    ...(sslKey !== undefined ? { sslKey } : {}),
    ...(token !== undefined ? { token } : {}),
  }
}

export const SHC_ROWS_TO_RECORD_ID = 'bosch-shc/2026-11-05-integration-rows-to-record'

/** The whole `bosch-shc` catalogue (D987): offered to the engine at `onInitialize`. */
export const SHC_MIGRATIONS: readonly AddonMigration<IntegrationRowsPorts>[] = [
  boschRowsMigration({
    addonId: 'bosch-shc',
    id: SHC_ROWS_TO_RECORD_ID,
    description:
      'Move every Smart Home Controller connection into a typed instance record keyed by its registry id, then clear the legacy integration settings rows and their keychain values',
    fixtureMark: 'a legacy setting key the migration does not know',
    kind: shcConnectionsEntryKind,
    bodyFrom: shcBodyFromRows,
  }),
]

export function shcRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: Pick<RecordsAccess, 'kind'>
  readonly warn: (message: string) => void
}): IntegrationRowsPorts {
  return boschRowsPorts({ ...deps, kind: shcConnectionsEntryKind })
}

/**
 * The live connection of one controller, read from its record. null while the connection is
 * incomplete; a locked keychain throws so the caller keeps the client it has instead of
 * reconfiguring it without its certificate (D49).
 */
export async function shcConnectionOf(
  instances: Pick<RecordIntegrationInstances<ShcConnectionBody>, 'readResolved'>,
  id: string,
): Promise<ShcConfig | null> {
  const read = await instances.readResolved(id)
  if (read === null) return null
  if (read.secrets === 'unavailable') {
    throw new Error('the keychain is locked, the saved controller credentials cannot be read')
  }
  return connectionFromSettings(read.body)
}

export interface ShcInstancesDeps {
  readonly onChanged: () => Promise<void>
  readonly tester: IConnectionTestProvider
}

export interface ShcInstances {
  readonly instances: RecordIntegrationInstances<ShcConnectionBody>
  readonly provider: ReturnType<RecordIntegrationInstances<ShcConnectionBody>['toProvider']>
}

export function buildShcInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: ShcInstancesDeps,
): ShcInstances {
  const handle = records.kind(shcConnectionsEntryKind)
  const instances = new RecordIntegrationInstances<ShcConnectionBody>(
    records,
    shcConnectionsEntryKind,
    {
      description: { role: 'devices', instanceMode: 'multiple', kind: 'controller', canTest: true },
      formSchema: () => buildConnectionFormSchema(),
      initialBody: (name): ShcConnectionBody => ({ name }),
      configured: (body) => connectionFromSettings(body) !== null,
      onChanged: async (_id, change) => {
        if (change !== 'deleted') await deps.onChanged()
      },
      test: (input) =>
        testBoschInstance({ ...input, tester: deps.tester, handle, secretKeys: SECRET_KEYS }),
    },
  )
  return {
    instances,
    provider: keepBodyKeys(
      instances.toProvider(),
      new Set(Object.keys(shcConnectionsEntryKind.schema.shape)),
    ),
  }
}
