/**
 * PetKit integrations as `integration-instances` (planning#416, D985, D1007): one `connections`
 * record per cloud account under the `integrations` registry id. The body IS the account (email,
 * password in the keychain, region, timezone, poll cadence), so the form the instances page edits
 * is the stored shape and the addon reads nothing else.
 */
import {
  type AddonMigration,
  defineEntryKind,
  entryBody,
  type IConnectionTestProvider,
  type IntegrationRowsApi,
  type RowsRecordsDoor,
  type SecretsAccess,
  type IntegrationRowsPorts,
  type IntegrationTestConnectionResult,
  integrationRowsPortsOverApi,
  moveIntegrationRowsToRecords,
  REDACTED_SECRET,
  RecordIntegrationInstances,
  type RecordsAccess,
  type RowsMigrationLog,
} from '@camstack/types'
import { z } from 'zod'
import { buildConnectionFormSchema, connectionFromSettings, type PetkitConfig } from './config.js'

export const petkitConnectionsEntryKind = defineEntryKind('connections', {
  title: 'PetKit accounts',
  schema: entryBody({
    email: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    region: z.string().optional(),
    timezone: z.string().optional(),
    pollIntervalMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a PetKit account',
})
export type PetkitConnectionBody = z.infer<typeof petkitConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const petkitRecordKinds = {
  connections: petkitConnectionsEntryKind,
} as const

/** The legacy row keys the record carries over; any other key is dropped and named. */
const LEGACY_KEYS: readonly string[] = ['email', 'password', 'region', 'timezone', 'pollIntervalMs']

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function whole(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The record body of one integration, from its legacy rows (secrets resolved). */
export function petkitBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: { readonly id: string; readonly name: string },
): PetkitConnectionBody {
  const dropped = Object.keys(values).filter((key) => !LEGACY_KEYS.includes(key))
  if (dropped.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${dropped.join(', ')}`,
    )
  }
  const email = text(values['email'])
  const password = text(values['password'])
  const region = text(values['region'])
  const timezone = text(values['timezone'])
  const pollIntervalMs = whole(values['pollIntervalMs'])
  return {
    name: integration.name,
    ...(email !== undefined ? { email } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  }
}

export const PETKIT_ROWS_TO_RECORD_ID = 'provider-petkit/2026-11-05-integration-rows-to-record'

/** The whole `provider-petkit` catalogue (D987): offered to the engine at `onInitialize`. */
export const PETKIT_MIGRATIONS: readonly AddonMigration<IntegrationRowsPorts>[] = [
  {
    meta: {
      id: PETKIT_ROWS_TO_RECORD_ID,
      owner: 'provider-petkit',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move every PetKit account into a typed instance record keyed by its registry id, then clear the legacy integration settings rows and their keychain values',
      fixtureMark: 'a legacy setting key the migration does not know',
    },
    procedure: (ports) =>
      moveIntegrationRowsToRecords(ports, {
        addonId: 'provider-petkit',
        secretPaths: petkitConnectionsEntryKind.declaration.secretPaths,
        bodyFrom: petkitBodyFromRows,
      }),
  },
]

/** The hub side and the records side of the move, over `ctx.api` and `ctx.records`. */
export function petkitRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: RowsRecordsDoor
  readonly warn: (message: string) => void
  readonly secrets?: Pick<SecretsAccess, 'resolve' | 'delete'> | null
}): IntegrationRowsPorts {
  return integrationRowsPortsOverApi({
    api: deps.api,
    ...(deps.secrets !== undefined ? { secrets: deps.secrets } : {}),
    records: deps.records.kind({
      name: petkitConnectionsEntryKind.name,
      declaration: petkitConnectionsEntryKind.declaration,
      schema: z.record(z.string(), z.unknown()),
    }),
    log: { warn: deps.warn },
  })
}

/**
 * The live account of one instance, read from its record. null while the credentials are missing;
 * a locked keychain throws so the caller keeps the client it has instead of reconfiguring it with
 * an empty password (D49).
 */
export async function petkitConnectionOf(
  instances: Pick<RecordIntegrationInstances<PetkitConnectionBody>, 'readResolved'>,
  id: string,
): Promise<PetkitConfig | null> {
  const read = await instances.readResolved(id)
  if (read === null) return null
  if (read.secrets === 'unavailable') {
    throw new Error('the keychain is locked, the saved password cannot be read')
  }
  return connectionFromSettings(read.body)
}

export interface PetkitInstancesDeps {
  /** Bring the runtime in line with the records after a change. */
  readonly onChanged: () => Promise<void>
  /** The addon's own credential check (the `connection-test` provider). */
  readonly tester: IConnectionTestProvider
}

function typedPassword(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value !== REDACTED_SECRET ? value : undefined
}

export function buildPetkitInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: PetkitInstancesDeps,
): RecordIntegrationInstances<PetkitConnectionBody> {
  const handle = records.kind(petkitConnectionsEntryKind)
  return new RecordIntegrationInstances<PetkitConnectionBody>(records, petkitConnectionsEntryKind, {
    description: {
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): PetkitConnectionBody => ({ name }),
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
  })
}
