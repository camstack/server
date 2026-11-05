/**
 * Rademacher integrations as `integration-instances` (planning#416, D985, D1007): one
 * `connections` record per HomePilot / Start2Smart hub under the `integrations` registry id. The
 * body IS the connection (host, password in the keychain, base path, poll interval), so the form
 * the instances page edits is the stored shape and the addon reads nothing else.
 */
import {
  type AddonMigration,
  defineEntryKind,
  entryBody,
  type IntegrationRowsApi,
  type RowsRecordsDoor,
  type SecretsAccess,
  type IntegrationRowsPorts,
  type IntegrationTestConnectionResult,
  type IConnectionTestProvider,
  integrationRowsPortsOverApi,
  moveIntegrationRowsToRecords,
  REDACTED_SECRET,
  RecordIntegrationInstances,
  type RecordsAccess,
  type RowsMigrationLog,
} from '@camstack/types'
import { z } from 'zod'
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  type RademacherConnectionConfig,
} from './config.js'

export const rademacherConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Rademacher hubs',
  schema: entryBody({
    host: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    basePath: z.string().optional(),
    pollIntervalMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a Rademacher hub connection',
})
export type RademacherConnectionBody = z.infer<typeof rademacherConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const rademacherRecordKinds = {
  connections: rademacherConnectionsEntryKind,
} as const

/** The legacy row keys the record carries over; any other key is dropped and named. */
const LEGACY_KEYS: readonly string[] = ['host', 'password', 'basePath', 'pollIntervalMs']

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function whole(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The record body of one integration, from its legacy rows (secrets resolved). */
export function rademacherBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: { readonly id: string; readonly name: string },
): RademacherConnectionBody {
  const dropped = Object.keys(values).filter((key) => !LEGACY_KEYS.includes(key))
  if (dropped.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${dropped.join(', ')}`,
    )
  }
  const host = text(values['host'])
  const password = text(values['password'])
  const basePath = text(values['basePath'])
  const pollIntervalMs = whole(values['pollIntervalMs'])
  return {
    name: integration.name,
    ...(host !== undefined ? { host } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(basePath !== undefined ? { basePath } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  }
}

export const RADEMACHER_ROWS_TO_RECORD_ID =
  'provider-rademacher/2026-11-05-integration-rows-to-record'

/** The whole `provider-rademacher` catalogue (D987): offered to the engine at `onInitialize`. */
export const RADEMACHER_MIGRATIONS: readonly AddonMigration<IntegrationRowsPorts>[] = [
  {
    meta: {
      id: RADEMACHER_ROWS_TO_RECORD_ID,
      owner: 'provider-rademacher',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move every Rademacher hub connection into a typed instance record keyed by its registry id, then clear the legacy integration settings rows and their keychain values',
      fixtureMark: 'a legacy setting key the migration does not know',
    },
    procedure: (ports) =>
      moveIntegrationRowsToRecords(ports, {
        addonId: 'provider-rademacher',
        secretPaths: rademacherConnectionsEntryKind.declaration.secretPaths,
        bodyFrom: rademacherBodyFromRows,
      }),
  },
]

/** The hub side and the records side of the move, over `ctx.api` and `ctx.records`. */
export function rademacherRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: RowsRecordsDoor
  readonly warn: (message: string) => void
  readonly secrets?: Pick<SecretsAccess, 'resolve' | 'delete'> | null
}): IntegrationRowsPorts {
  return integrationRowsPortsOverApi({
    api: deps.api,
    ...(deps.secrets !== undefined ? { secrets: deps.secrets } : {}),
    records: deps.records.kind({
      name: rademacherConnectionsEntryKind.name,
      declaration: rademacherConnectionsEntryKind.declaration,
      schema: z.record(z.string(), z.unknown()),
    }),
    log: { warn: deps.warn },
  })
}

export interface RademacherInstancesDeps {
  /** Bring the runtime in line with the records after a change. */
  readonly onChanged: () => Promise<void>
  /** The addon's own connection probe (the `connection-test` provider). */
  readonly tester: IConnectionTestProvider
}

/**
 * The live connection of one instance, read from its record. null while the host is missing; a
 * locked keychain throws so the caller keeps the client it has instead of reconfiguring it with an
 * empty password (D49).
 */
export async function rademacherConnectionOf(
  instances: Pick<RecordIntegrationInstances<RademacherConnectionBody>, 'readResolved'>,
  id: string,
): Promise<RademacherConnectionConfig | null> {
  const read = await instances.readResolved(id)
  if (read === null) return null
  if (read.secrets === 'unavailable') {
    throw new Error('the keychain is locked, the saved password cannot be read')
  }
  return connectionFromSettings(read.body)
}

function typedPassword(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value !== REDACTED_SECRET ? value : undefined
}

export function buildRademacherInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: RademacherInstancesDeps,
): RecordIntegrationInstances<RademacherConnectionBody> {
  const handle = records.kind(rademacherConnectionsEntryKind)
  return new RecordIntegrationInstances<RademacherConnectionBody>(
    records,
    rademacherConnectionsEntryKind,
    {
      description: {
        role: 'devices',
        instanceMode: 'multiple',
        kind: 'connection',
        canTest: true,
      },
      formSchema: () => buildConnectionFormSchema(),
      initialBody: (name): RademacherConnectionBody => ({ name }),
      configured: (body) => connectionFromSettings(body) !== null,
      onChanged: async (_id, change) => {
        if (change !== 'deleted') await deps.onChanged()
      },
      test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
        // A saved password is never typed again: the form hands back its view, so read it from the record.
        const stored = id === null ? null : ((await handle.getResolved(id))?.data.password ?? null)
        const password = typedPassword(values['password']) ?? stored ?? ''
        const outcome = await deps.tester.testSettings({
          settings: { ...values, password },
        })
        if (outcome.outcome === 'validated') {
          return {
            success: true,
            status: 'validated',
            ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
            ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
          }
        }
        return {
          success: false,
          status: outcome.outcome,
          error: outcome.error,
        }
      },
    },
  )
}
