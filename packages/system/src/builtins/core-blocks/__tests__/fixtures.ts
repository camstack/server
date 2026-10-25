/**
 * Typed fakes shared by the core-blocks specs: a logger that records what it
 * was told, and an in-memory settings store whose read can be made to fail.
 */
import {
  createRecordsAccess,
  type IScopedLogger,
  LogExtras,
  SettingsStoreClient,
} from '@camstack/types'
import { readAllRows } from '../../../records/read-all-rows.js'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { BlockSettingsStore, type SecretsForOwner } from '../block-settings-store.js'
import { CoreBlockStore } from '../core-block-store.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: LogExtras | undefined
}

export interface RecordingLogger {
  readonly logger: IScopedLogger
  readonly lines: LogLine[]
}

export function recordingLogger(): RecordingLogger {
  const lines: LogLine[] = []
  const logger: IScopedLogger = {
    debug: (message, extras) => lines.push({ level: 'debug', message, extras }),
    info: (message, extras) => lines.push({ level: 'info', message, extras }),
    warn: (message, extras) => lines.push({ level: 'warn', message, extras }),
    error: (message, extras) => lines.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

/** One stored row as `settingsStore.query` answers it. */
export interface FakeSettingsRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

export interface FakeSettingsStore {
  readonly client: SettingsStoreClient
  /** Rows by key; a spec may seed rows the store's own writes would never produce. */
  readonly rows: Map<string, Record<string, unknown>>
  /** Reads answered so far, failed ones included. */
  reads(): number
  /** The `addon-settings` rows a prefs write mirrors into the block addon (D870). */
  readonly addonRows: Map<string, Record<string, unknown>>
}

/**
 * In-memory stand-in for the settings-store cap — the four calls the store
 * makes. The first `failures` reads throw.
 */
export function fakeSettingsStore(failures = 0): FakeSettingsStore {
  const rows = new Map<string, Record<string, unknown>>()
  /** Namespaced rows: `${namespace}/${collection}/${key}` → value. */
  const namespaced = new Map<string, Record<string, unknown>>()
  let reads = 0
  let left = failures
  /** The addon-settings rows a prefs write mirrors into (D870): `id` -> data. */
  const addonRows = new Map<string, Record<string, unknown>>()
  const query = async (input?: {
    collection?: string
    filter?: { whereBetween?: Record<string, readonly [string, string]> }
  }): Promise<readonly FakeSettingsRow[]> => {
    reads += 1
    if (left > 0) {
      left -= 1
      throw new Error('SQLITE_BUSY')
    }
    if (input?.collection === 'addon-settings') {
      const between = input.filter?.whereBetween?.['id']
      return [...addonRows.entries()]
        .filter(([id]) => between === undefined || (id >= between[0] && id < between[1]))
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, data]) => ({ id, data }))
    }
    return [...rows.entries()].map(([id, data]) => ({ id, data }))
  }
  const fake = {
    declareCollection: { mutate: async (): Promise<void> => undefined },
    query: { query },
    get: {
      query: async ({
        namespace,
        collection,
        key,
      }: {
        namespace?: string
        collection: string
        key: string
      }): Promise<Record<string, unknown> | null> => {
        if (namespace !== undefined) {
          return namespaced.get(`${namespace}/${collection}/${key}`) ?? null
        }
        // Prefer collection-scoped keys when the fake is shared across stores.
        return rows.get(`${collection}/${key}`) ?? rows.get(key) ?? null
      },
    },
    set: {
      mutate: async ({
        namespace,
        collection,
        key,
        value,
      }: {
        namespace?: string
        collection?: string
        key: string
        value: Record<string, unknown>
      }) => {
        if (namespace !== undefined && collection !== undefined) {
          namespaced.set(`${namespace}/${collection}/${key}`, value)
          return
        }
        if (collection !== undefined) {
          rows.set(`${collection}/${key}`, value)
          rows.set(key, value)
          return
        }
        rows.set(key, value)
      },
    },
    transact: {
      mutate: async ({
        ops,
      }: {
        ops: readonly {
          op: string
          filter?: { whereIn?: Record<string, readonly unknown[]> }
          records?: readonly { id: string; data: Record<string, unknown> }[]
        }[]
      }): Promise<{ applied: boolean }> => {
        for (const op of ops) {
          if (op.op === 'deleteWhere') {
            for (const id of op.filter?.whereIn?.['id'] ?? []) addonRows.delete(String(id))
          } else if (op.op === 'upsertMany') {
            for (const r of op.records ?? []) addonRows.set(r.id, r.data)
          }
        }
        return { applied: true }
      },
    },
    delete: {
      mutate: async ({ collection, key }: { collection?: string; key: string }) => {
        rows.delete(key)
        if (collection !== undefined) rows.delete(`${collection}/${key}`)
      },
    },
  }
  // Documented type boundary: `SettingsStoreClient` is the full tRPC client of
  // the settings-store cap; the store under test calls only the procedures
  // above, and a fake of the rest would be dead weight.
  const client = fake as unknown as SettingsStoreClient
  return { client, rows, reads: () => reads, addonRows }
}

export async function coreBlockRecordsHarness(
  logger: IScopedLogger,
  opts?: { readonly now?: () => number; readonly newId?: () => string },
): Promise<{
  readonly store: CoreBlockStore
  readonly records: ReturnType<typeof createRecordsAccess>
}> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: world.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const store = new CoreBlockStore({
    blocks: records.kind(coreBlocksRecordKinds.blocks),
    logger,
    now: opts?.now,
    newId: opts?.newId,
  })
  return { store, records }
}

export async function blockSettingsStoreHarness(
  keychainFor: SecretsForOwner,
  settings: FakeSettingsStore = fakeSettingsStore(),
): Promise<{
  readonly prefs: BlockSettingsStore
  readonly settings: FakeSettingsStore
  readonly records: ReturnType<typeof createRecordsAccess>
}> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: world.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const prefs = new BlockSettingsStore({
    store: settings.client,
    legacySettings: records.kind(coreBlocksRecordKinds.settings),
    keychainFor,
  })
  return { prefs, settings, records }
}

export async function coreBlockStoreHarness(
  logger: IScopedLogger,
  opts?: { readonly now?: () => number; readonly newId?: () => string },
): Promise<CoreBlockStore> {
  return (await coreBlockRecordsHarness(logger, opts)).store
}

/** Seed persisted hub-main `core_blocks` rows into the records kind (composer e2e restarts). */
export async function seedCoreBlockKindRows(
  records: ReturnType<typeof createRecordsAccess>,
  rows: ReadonlyMap<string, Record<string, unknown>>,
): Promise<void> {
  const kind = records.kind(coreBlocksRecordKinds.blocks)
  for (const [id, data] of rows) {
    const parsed = coreBlocksRecordKinds.blocks.schema.safeParse(data)
    if (!parsed.success) throw new Error(`invalid seeded core block row ${id}`)
    await kind.put({ id, data: parsed.data })
  }
}

/** Snapshot block rows for a hub restart fixture. */
export async function exportCoreBlockKindRows(
  records: ReturnType<typeof createRecordsAccess>,
): Promise<Map<string, Record<string, unknown>>> {
  const kind = records.kind(coreBlocksRecordKinds.blocks)
  const rows = await readAllRows(kind)
  const out = new Map<string, Record<string, unknown>>()
  for (const row of rows) out.set(row.id, { ...row.data })
  return out
}
