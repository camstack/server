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
  type MigrationApiV1,
  type MigrationRecordsKindV1,
  type RecordsAccess,
  type SecretsAccess,
} from '@camstack/types'
import { MIGRATION_API_VERSION } from '@camstack/types/addon'
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
  /** The registry's stored switch, for the one-switch migration only (epic #440, step 3). */
  readonly enabled?: boolean | undefined
  readonly originStableId?: string | undefined
}

/** The device registry slice a migration may touch; `list` is already scoped to one addon. */
export interface DevicesDoor {
  list(addonId: string): Promise<
    readonly {
      readonly id: number
      readonly integrationId?: string | null | undefined
      readonly parentDeviceId?: number | null | undefined
      readonly type?: string | undefined
      readonly name?: string | undefined
      readonly stableId?: string | undefined
    }[]
  >
  get(deviceId: number): Promise<{
    readonly integrationId?: string | null | undefined
    readonly config?: Readonly<Record<string, unknown>> | undefined
  } | null>
  setIntegrationId(deviceId: number, integrationId: string): Promise<void>
  /** The template alias of each named device that has one (explicit ids, never a walk). */
  aliasesOf(deviceIds: readonly number[]): Promise<ReadonlyMap<number, string>>
}

export interface MigrationApiBacking {
  readonly devices: DevicesDoor
  readonly nodeId: string
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  readonly ledger: AddonMigrationHost
  readonly legacy: LegacyRowsDoor
  readonly listIntegrations: () => Promise<readonly MigrationIntegrationRow[]>
  readonly records: RecordsAccess | undefined
  readonly secrets: SecretsAccess | undefined
  readonly settings:
    | Pick<
        NonNullable<AddonContext['settings']>,
        'readAddonStore' | 'writeAddonStore' | 'listDeviceStoreIds' | 'readDeviceStoreBatch'
      >
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
    deviceSettings: {
      listIds: async () => ({
        deviceIds: [...(await requireSettings(backing.settings).listDeviceStoreIds())],
      }),
      read: async ({ deviceIds }) => {
        const found = await requireSettings(backing.settings).readDeviceStoreBatch(deviceIds)
        return {
          // A device with nothing stored answers `{}` from the store; the contract calls that absent.
          blobs: Object.fromEntries(
            [...found]
              .filter(([, blob]) => Object.keys(blob).length > 0)
              .map(([id, blob]) => [String(id), { ...blob }]),
          ),
        }
      },
    },
    devices: {
      aliases: async ({ deviceIds }) => ({
        aliases: Object.fromEntries(
          [...(await backing.devices.aliasesOf(deviceIds))].map(([id, alias]) => [
            String(id),
            alias,
          ]),
        ),
      }),
      list: async ({ addonId, integrationId }) => ({
        devices: (await backing.devices.list(addonId))
          .filter((d) => integrationId === undefined || d.integrationId === integrationId)
          .map((d) => ({ ...d })),
      }),
      get: async ({ deviceId }) => {
        const found = await backing.devices.get(deviceId)
        if (found === null) return null
        return {
          id: deviceId,
          integrationId: found.integrationId ?? null,
          hasConfig: Object.keys(found.config ?? {}).length > 0,
        }
      },
      setIntegrationId: async ({ deviceId, integrationId }) => {
        await backing.devices.setIntegrationId(deviceId, integrationId)
        return {}
      },
    },
    node: { localNodeId: async () => ({ nodeId: backing.nodeId }) },
    log: {
      info: async ({ message, meta, tags }) => {
        logger.info(message, {
          ...(meta === undefined ? {} : { meta }),
          ...(tags === undefined ? {} : { tags }),
        })
        return {}
      },
      warn: async ({ message, meta, tags }) => {
        logger.warn(message, {
          ...(meta === undefined ? {} : { meta }),
          ...(tags === undefined ? {} : { tags }),
        })
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
  enabled?: boolean
  originStableId?: string
} {
  return {
    id: row.id,
    addonId: row.addonId,
    name: row.name,
    info: { ...row.info },
    ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
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
    devices: {
      list: (addonId) => deps.api().deviceManager.listAll.query({ addonId, projection: 'slim' }),
      get: (deviceId) => deps.api().deviceManager.getDevice.query({ deviceId }),
      setIntegrationId: async (deviceId, integrationId) => {
        await deps.api().deviceManager.setIntegrationId.mutate({ deviceId, integrationId })
      },
      aliasesOf: async (deviceIds) => {
        const found = new Map<number, string>()
        for (const deviceId of new Set(deviceIds)) {
          const device = await deps.api().deviceManager.getDevice.query({ deviceId })
          if (device?.alias !== undefined) found.set(deviceId, device.alias)
        }
        return found
      },
    },
    records: deps.records,
    secrets: deps.secrets,
    settings: deps.settings,
  })
}
