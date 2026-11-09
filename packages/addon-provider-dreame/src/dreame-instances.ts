/**
 * Dreame integrations as `integration-instances` (planning#416, D985, D1007): one `connections`
 * record per cloud account under the `integrations` registry id. The body IS the account (username,
 * password in the keychain, region, timezone, poll cadence), so the form the instances page edits
 * is the stored shape and the addon reads nothing else.
 */
import {
  type AddonMigration,
  defineEntryKind,
  entryBody,
  type IConnectionProbe,
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
import { buildConnectionFormSchema, connectionFromSettings, type DreameConfig } from './config.js'

export const dreameConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Dreamehome accounts',
  schema: entryBody({
    username: z.string().optional(),
    password: z.string().optional().meta({ secret: true }),
    region: z.string().optional(),
    pollIntervalMs: z.number().optional(),
  }),
  writeTrigger: 'an operator adds, edits or removes a Dreame account',
})
export type DreameConnectionBody = z.infer<typeof dreameConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const dreameRecordKinds = {
  connections: dreameConnectionsEntryKind,
} as const

/** The legacy row keys the record carries over; any other key is dropped and named. */
const LEGACY_KEYS: readonly string[] = ['username', 'password', 'region', 'pollIntervalMs']

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function whole(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The record body of one integration, from its legacy rows (secrets resolved). */
export function dreameBodyFromRows(
  values: Readonly<Record<string, unknown>>,
  log: RowsMigrationLog,
  integration: { readonly id: string; readonly name: string },
): DreameConnectionBody {
  const dropped = Object.keys(values).filter((key) => !LEGACY_KEYS.includes(key))
  if (dropped.length > 0) {
    log.warn(
      `integration '${integration.id}': legacy settings nothing reads any more are dropped: ${dropped.join(', ')}`,
    )
  }
  const username = text(values['username'])
  const password = text(values['password'])
  const region = text(values['region'])
  const pollIntervalMs = whole(values['pollIntervalMs'])
  return {
    name: integration.name,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  }
}

export const DREAME_ROWS_TO_RECORD_ID = 'provider-dreame/2026-11-05-integration-rows-to-record'

/** The whole `provider-dreame` catalogue (D987): offered to the engine at `onInitialize`. */
export const DREAME_MIGRATIONS: readonly AddonMigration<IntegrationRowsPorts>[] = [
  {
    meta: {
      id: DREAME_ROWS_TO_RECORD_ID,
      owner: 'provider-dreame',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move every Dreame account into a typed instance record keyed by its registry id, then clear the legacy integration settings rows and their keychain values',
      fixtureMark: 'a legacy setting key the migration does not know',
    },
    procedure: (ports) =>
      moveIntegrationRowsToRecords(ports, {
        addonId: 'provider-dreame',
        secretPaths: dreameConnectionsEntryKind.declaration.secretPaths,
        bodyFrom: dreameBodyFromRows,
      }),
  },
]

/** The hub side and the records side of the move, over `ctx.api` and `ctx.records`. */
export function dreameRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: RowsRecordsDoor
  readonly warn: (message: string) => void
  readonly secrets?: Pick<SecretsAccess, 'resolve' | 'delete'> | null
}): IntegrationRowsPorts {
  return integrationRowsPortsOverApi({
    api: deps.api,
    ...(deps.secrets !== undefined ? { secrets: deps.secrets } : {}),
    records: deps.records.kind({
      name: dreameConnectionsEntryKind.name,
      declaration: dreameConnectionsEntryKind.declaration,
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
export async function dreameConnectionOf(
  instances: Pick<RecordIntegrationInstances<DreameConnectionBody>, 'readResolved'>,
  id: string,
): Promise<DreameConfig | null> {
  const read = await instances.readResolved(id)
  if (read === null) return null
  if (read.secrets === 'unavailable') {
    throw new Error('the keychain is locked, the saved password cannot be read')
  }
  return connectionFromSettings(read.body)
}

export interface DreameInstancesDeps {
  /** Bring the runtime in line with the records after a change. */
  readonly onChanged: () => Promise<void>
  /** The addon's own credential check (the connection probe `testInstance` runs). */
  readonly tester: IConnectionProbe
}

function typedPassword(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value !== REDACTED_SECRET ? value : undefined
}

export function buildDreameInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: DreameInstancesDeps,
): RecordIntegrationInstances<DreameConnectionBody> {
  const handle = records.kind(dreameConnectionsEntryKind)
  return new RecordIntegrationInstances<DreameConnectionBody>(records, dreameConnectionsEntryKind, {
    description: {
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'account',
      canTest: true,
      kinds: [
        { id: 'connection', label: 'Dreame', functionCap: 'device-provider', role: 'devices' },
      ],
    },
    formSchema: () => buildConnectionFormSchema(),
    initialBody: (name): DreameConnectionBody => ({ name }),
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
