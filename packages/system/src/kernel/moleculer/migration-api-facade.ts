/**
 * `ctx.migrationApi` (planning#447): {@link MigrationApiV1} built over the handles an addon
 * context already has. Nothing here owns state or decides anything; each method is one call
 * onto an existing door, with the answer shaped to the contract in
 * `migration-api.v1.schema.ts`. That contract is append-only, so this file only ever grows.
 */

import type { DefinedRecordKind } from '@camstack/types'
import {
  type AddonApi,
  type AddonContext,
  type AddonMigrationHost,
  type IScopedLogger,
  MIGRATION_API_VERSION,
  type MigrationApiV1,
  type MigrationRecordsKindV1,
  type RecordsAccess,
  type SecretsAccess,
} from '@camstack/types'
import type { z } from 'zod'

/** The migration-only door for the pre-records integration rows. */
export interface LegacyRowsDoor {
  read(input: { integrationId: string }): Promise<Readonly<Record<string, unknown>>>
  clear(input: { integrationId: string }): Promise<{ rows: number; secrets: number }>
  patch(input: {
    integrationId: string
    patch: Record<string, unknown>
  }): Promise<{ written: boolean }>
  deleteKeys(input: {
    integrationId: string
    keys: string[]
  }): Promise<{ present: boolean; removed: Record<string, unknown> }>
}

export interface MigrationIntegrationRow {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly info: Readonly<Record<string, unknown>>
  readonly originStableId?: string | undefined
}

export interface MigrationApiBacking {
  readonly nodeId: string
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  readonly ledger: AddonMigrationHost
  readonly legacy: LegacyRowsDoor
  readonly listIntegrations: () => Promise<readonly MigrationIntegrationRow[]>
  readonly records: RecordsAccess | undefined
  readonly secrets: SecretsAccess | undefined
  readonly settings:
    | Pick<NonNullable<AddonContext['settings']>, 'readAddonStore' | 'writeAddonStore'>
    | undefined
}

const DEFAULT_QUERY_LIMIT = 100

function recordsKind<S extends z.ZodType>(
  records: RecordsAccess | undefined,
  definition: DefinedRecordKind<S>,
): MigrationRecordsKindV1<z.infer<S>> {
  if (records === undefined) throw new Error('migration api: records are not available')
  const handle = records.kind(definition)
  return {
    get: ({ id }) => handle.get(id),
    getResolved: ({ id }) => handle.getResolved(id),
    put: ({ ifRev, ...row }) => handle.put(row, ifRev === undefined ? undefined : { ifRev }),
    putMany: ({ records: rows }) => handle.putMany(rows),
    patch: ({ id, partial, ifRev }) =>
      handle.patch(id, partial, ifRev === undefined ? undefined : { ifRev }),
    delete: async ({ id }) => ({ deleted: await handle.delete(id) }),
    query: ({ limit, resolveSecrets, ...rest }) =>
      handle.query(
        { ...rest, limit: limit ?? DEFAULT_QUERY_LIMIT },
        resolveSecrets === undefined ? undefined : { resolveSecrets },
      ),
    deleteWhere: async (input) => ({ count: await handle.deleteWhere(input) }),
  }
}

function requireSecrets(secrets: SecretsAccess | undefined): SecretsAccess {
  if (secrets === undefined) throw new Error('migration api: the keychain is not available')
  return secrets
}

function requireSettings(
  settings: MigrationApiBacking['settings'],
): NonNullable<MigrationApiBacking['settings']> {
  if (settings === undefined) throw new Error('migration api: settings are not available')
  return settings
}

export function createMigrationApi(backing: MigrationApiBacking): MigrationApiV1 {
  const { legacy, ledger, logger } = backing
  return {
    version: MIGRATION_API_VERSION,
    ledger: {
      declare: (input) => ledger.declareOwner(input),
      start: (input) => ledger.startMigration(input),
      finish: (input) => ledger.finishMigration(input),
    },
    legacyRows: {
      read: (input) => legacy.read(input),
      clear: (input) => legacy.clear(input),
      patch: (input) => legacy.patch(input),
      deleteKeys: (input) => legacy.deleteKeys({ ...input, keys: [...input.keys] }),
    },
    records: { kind: (definition) => recordsKind(backing.records, definition) },
    settings: {
      read: async () => ({ store: await requireSettings(backing.settings).readAddonStore() }),
      write: async ({ patch }) => {
        await requireSettings(backing.settings).writeAddonStore(patch)
        return {}
      },
      deleteKeys: async ({ keys }) => {
        const settings = requireSettings(backing.settings)
        const stored = await settings.readAddonStore()
        const removed = keys.filter((key) => key in stored)
        if (removed.length > 0) {
          await settings.writeAddonStore(Object.fromEntries(removed.map((k) => [k, undefined])))
        }
        return { removed }
      },
    },
    secrets: {
      resolve: async ({ refs }) => {
        const answers = await requireSecrets(backing.secrets).resolve(refs)
        const values: Record<string, string | null> = {}
        for (const ref of refs) {
          const answer = answers[ref]
          if (answer === undefined || answer.kind === 'missing') values[ref] = null
          else if (answer.kind === 'value') values[ref] = answer.value
          else {
            // A locked keychain is not an empty secret: never hand back a value that is not one.
            throw new Error(
              `migration api: a secret cannot be read (${answer.kind === 'unavailable' ? answer.reason : answer.kind})`,
            )
          }
        }
        return { values }
      },
      put: async ({ ref, value }) => {
        await requireSecrets(backing.secrets).put(ref, value)
        return {}
      },
      delete: async ({ refs }) => ({ deleted: await requireSecrets(backing.secrets).delete(refs) }),
    },
    integrations: {
      list: async () => ({
        integrations: (await backing.listIntegrations()).map(toIntegration),
      }),
      get: async ({ id }) => {
        const found = (await backing.listIntegrations()).find((row) => row.id === id)
        return found === undefined ? null : toIntegration(found)
      },
    },
    node: { localNodeId: async () => ({ nodeId: backing.nodeId }) },
    log: {
      info: async ({ message, meta }) => {
        logger.info(message, meta === undefined ? undefined : { meta })
        return {}
      },
      warn: async ({ message, meta }) => {
        logger.warn(message, meta === undefined ? undefined : { meta })
        return {}
      },
    },
  }
}

function toIntegration(row: MigrationIntegrationRow): {
  id: string
  addonId: string
  name: string
  info: Record<string, unknown>
  originStableId?: string
} {
  return {
    id: row.id,
    addonId: row.addonId,
    name: row.name,
    info: { ...row.info },
    ...(row.originStableId === undefined ? {} : { originStableId: row.originStableId }),
  }
}

/** What a context builder hands over: the lazily resolved `ctx.api` and the addon's own handles. */
export interface MigrationApiContextDeps {
  readonly nodeId: string
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  /** A getter: a hub in-process context resolves `api` per call. */
  readonly api: () => AddonApi
  readonly records: RecordsAccess | undefined
  readonly secrets: SecretsAccess | undefined
  readonly settings: MigrationApiBacking['settings']
}

/** The facade over a context's `api` (the caller is stamped by the transport, never claimed here). */
export function createMigrationApiOverContext(deps: MigrationApiContextDeps): MigrationApiV1 {
  const migrations = () => deps.api().migrations
  return createMigrationApi({
    nodeId: deps.nodeId,
    logger: deps.logger,
    ledger: {
      declareOwner: (input) => migrations().declareOwner.mutate(input),
      startMigration: (input) => migrations().startMigration.mutate(input),
      finishMigration: (input) => migrations().finishMigration.mutate(input),
    },
    legacy: {
      read: (input) => migrations().readLegacyIntegrationRows.query(input),
      clear: (input) => migrations().clearLegacyIntegrationRows.mutate(input),
      patch: (input) => migrations().patchLegacyIntegrationRows.mutate(input),
      deleteKeys: (input) => migrations().deleteLegacyIntegrationRowKeys.mutate(input),
    },
    listIntegrations: () => deps.api().integrations.list.query(),
    records: deps.records,
    secrets: deps.secrets,
    settings: deps.settings,
  })
}
