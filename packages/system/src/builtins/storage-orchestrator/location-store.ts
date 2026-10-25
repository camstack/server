/**
 * Persistence layer for the storage-orchestrator's `StorageLocation`
 * map (Task 6 of the storage-unification refactor).
 *
 * The service depends only on the abstract `ILocationStore` —
 * production wires `SqliteLocationStore` (settings-backend-backed),
 * tests pass a fake (in-memory `Map`-backed) implementation. Same
 * pattern as `IntegrationRegistry` in `sqlite-storage/`.
 */
import type {
  CollectionColumn,
  CollectionIndex,
  ISettingsStoreProvider,
  LegacyStorageLocationDefault,
  RecordKindHandle,
  RecordsAccess,
  StorageLocation,
  StorageLocationType,
} from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import {
  storageOrchestratorRecordKinds,
  type StorageLocationBody,
  type StorageSeedMarkerBody,
} from './record-kinds.js'
import {
  LegacyStorageLocationDefaultSchema,
  parseJsonObject,
  StorageLocationModeSchema,
  StorageLocationTypeSchema,
} from '@camstack/types'

/**
 * A location as it comes back OFF DISK: the live record plus the retired
 * `isDefault` column, which exists only so the orchestrator's boot migration
 * can turn an old default into the enabled write set and say which row it came
 * from. No other reader may take this type.
 */
export type PersistedStorageLocation = StorageLocation & LegacyStorageLocationDefault

/**
 * Abstract storage interface for `StorageLocation` records. Methods are
 * async because production-side implementations hit SQLite — but the
 * orchestrator's mutation paths fire-and-forget the writes so a slow
 * disk doesn't block the cap surface.
 */
export interface ILocationStore {
  /** Read every persisted location. Called once at boot. Rows carry the
   *  RETIRED `isDefault` column when it was set, for the one reader allowed to
   *  see it: the orchestrator's boot migration onto the `enabled` write set. */
  loadAll(): Promise<readonly PersistedStorageLocation[]>
  /** Insert or replace a single location by id. */
  upsert(loc: StorageLocation): Promise<void>
  /** Remove a location by id. */
  delete(id: string): Promise<void>
  /**
   * The location types a default was ever seeded for (or that already existed
   * when this memory began). Absent on a store that cannot remember — such a
   * store seeds on "type has no row", as before.
   */
  loadSeededTypes?(): Promise<readonly string[]>
  markTypeSeeded?(type: string): Promise<void>
}

/**
 * @durable class=config owner=storage-orchestrator
 *   write="an operator creates or edits a location (basePath, minFreePercent, enabled, node pin); plus the boot reconcile — declared defaults seeded on a fresh install, and in-memory-only locations backfilled when the store is late-wired"
 *   retention="none — a row goes only when the operator deletes the location, or when the declaration pass prunes one whose declaring addon is gone. Bounded by the storage targets a human configures."
 */
export const STORAGE_LOCATIONS = 'storage_locations'

/**
 * Reserved key under which the cluster `nodeId` (SP1) is persisted INSIDE
 * the `config` JSON blob. Storing it in the blob rather than a dedicated
 * column avoids a destructive `ensureTable` DROP+recreate on deploy (a
 * newly-declared column counts as a missing column → the structured
 * backend drops the table, wiping operator location customizations such
 * as `recordings:default`'s `minFreePercent`). The double-underscore
 * prefix keeps it out of the provider-facing config namespace
 * (`basePath`, `minFreePercent`, …) — the mapper strips it on read so
 * API consumers and providers never see it.
 */
const NODE_ID_CONFIG_KEY = '__nodeId'

/**
 * Reserved key under which the operator opt-in flag (`StorageLocation.enabled`)
 * is persisted INSIDE the `config` JSON blob — same channel, same reason, as
 * {@link NODE_ID_CONFIG_KEY}: a newly-declared COLUMN counts as a missing
 * column, and the structured backend answers that by dropping and recreating
 * the table, wiping every operator customization on it.
 *
 * ABSENT means ACTIVE. A row written before the flag existed carries no key and
 * reads back with `enabled: undefined`, which every consumer treats as enabled —
 * that is why this ships with no migration and no backfill pass.
 */
const ENABLED_CONFIG_KEY = '__enabled'

/**
 * Reserved key under which the location's typed STATE ({@link
 * StorageLocationMode}, D385) is persisted — same channel, same reason, as
 * {@link NODE_ID_CONFIG_KEY} and {@link ENABLED_CONFIG_KEY}.
 *
 * ABSENT means UNSTAMPED, not `active`: the orchestrator's boot migration folds
 * the legacy `enabled` / `config.readOnly` pair into a mode and writes it once.
 * Reading absence as a state here would do that fold on every read forever,
 * which is the thing D385 removes.
 */
const MODE_CONFIG_KEY = '__mode'

/**
 * `config` is declared `JSON`, so the store hands the surface an object and
 * gets an object back. There is deliberately NO `node_id` column — `nodeId`
 * rides inside the blob under a reserved key (see {@link NODE_ID_CONFIG_KEY}),
 * because a newly-declared column would put this table through
 * `declareCollection`'s destructive rebuild and wipe operator customizations
 * such as `recordings:default`'s `minFreePercent`.
 */
const STORAGE_LOCATIONS_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT', primaryKey: true },
  { name: 'type', type: 'TEXT', notNull: true },
  { name: 'display_name', type: 'TEXT', notNull: true },
  { name: 'provider_id', type: 'TEXT', notNull: true },
  { name: 'config', type: 'JSON', notNull: true, defaultValue: '{}' },
  { name: 'is_default', type: 'INTEGER', notNull: true, defaultValue: 0 },
  { name: 'is_system', type: 'INTEGER', notNull: true, defaultValue: 0 },
  { name: 'created_at', type: 'INTEGER', notNull: true },
  { name: 'updated_at', type: 'INTEGER', notNull: true },
]

const STORAGE_LOCATIONS_INDEXES: readonly CollectionIndex[] = [
  { name: 'idx_storage_locations_type', columns: ['type'] },
]

/**
 * `ILocationStore` on the `settings-store` collection surface — the same door
 * every other consumer uses. It holds the `data-store-provider` engine object
 * directly (not the `settings-store` singleton) because since D44 the
 * storage-orchestrator IS that singleton, and asking the registry for it would
 * route this table back through the orchestrator itself.
 */
export class SqliteLocationStore implements ILocationStore {
  private declared = false
  private readonly locationsKind: RecordKindHandle<StorageLocationBody> | null

  constructor(
    private readonly store: ISettingsStoreProvider,
    locationsKind: RecordKindHandle<StorageLocationBody> | null = null,
    seedMarkersKind: RecordKindHandle<StorageSeedMarkerBody> | null = null,
  ) {
    this.locationsKind = locationsKind
    this.seedMarkersKind = seedMarkersKind
  }

  private readonly seedMarkersKind: RecordKindHandle<StorageSeedMarkerBody> | null

  static seedMarkersOf(
    records: Pick<RecordsAccess, 'kind'>,
  ): RecordKindHandle<StorageSeedMarkerBody> {
    return records.kind(storageOrchestratorRecordKinds['seed-markers'])
  }

  async loadSeededTypes(): Promise<readonly string[]> {
    const kind = this.seedMarkersKind
    if (kind === null) return []
    return (await readAllRows(kind)).map((r) => r.id)
  }

  async markTypeSeeded(type: string): Promise<void> {
    const kind = this.seedMarkersKind
    if (kind === null) return
    await kind.put({ id: type, data: { seededAt: Date.now() } })
  }

  static recordStoresOf(
    records: Pick<RecordsAccess, 'kind'>,
  ): RecordKindHandle<StorageLocationBody> {
    return records.kind(storageOrchestratorRecordKinds.locations)
  }

  /**
   * Lazy `declareCollection` — keeps the constructor cheap and async-free.
   * Called from every mutation/read path; `declareCollection` is idempotent
   * (and additive on shape changes), so repeated calls collapse to a no-op.
   */
  private async ensureDeclared(): Promise<void> {
    if (this.locationsKind !== null) return
    if (this.declared) return
    await this.store.declareCollection({
      collection: STORAGE_LOCATIONS,
      columns: STORAGE_LOCATIONS_COLUMNS,
      indexes: STORAGE_LOCATIONS_INDEXES,
    })
    this.declared = true
  }

  async loadAll(): Promise<readonly StorageLocation[]> {
    await this.ensureDeclared()
    const kind = this.locationsKind
    if (kind !== null) {
      const rows = await readAllRows(kind)
      rows.sort((a, b) => a.data.createdAt - b.data.createdAt)
      const out: StorageLocation[] = []
      for (const row of rows) {
        const mapped = bodyToPersistedLocation(row.id, row.data)
        if (mapped) out.push(mapped)
      }
      return out
    }
    const rows = await this.store.query({
      collection: STORAGE_LOCATIONS,
      filter: { orderBy: { field: 'created_at', direction: 'asc' } },
    })
    const out: StorageLocation[] = []
    for (const row of rows) {
      const mapped = mapRowToLocation(row.data)
      if (mapped) out.push(mapped)
    }
    return out
  }

  /**
   * Replace-or-insert. Implemented as delete + insert rather than a
   * conditional update because the orchestrator serializes every mutation
   * through the in-memory map before dispatching to the store — there's no
   * contention to lose, and delete-then-insert is unconditionally simpler.
   */
  async upsert(loc: StorageLocation): Promise<void> {
    await this.ensureDeclared()
    const kind = this.locationsKind
    if (kind !== null) {
      const body = locationToBody(loc)
      const data = storageOrchestratorRecordKinds.locations.schema.parse(body)
      await kind.put({ id: loc.id, data })
      return
    }
    await this.store.deleteWhere({
      collection: STORAGE_LOCATIONS,
      filter: { where: { id: loc.id } },
    })
    await this.store.insert({
      collection: STORAGE_LOCATIONS,
      record: { id: loc.id, data: mapLocationToRow(loc) },
    })
  }

  async delete(id: string): Promise<void> {
    await this.ensureDeclared()
    const kind = this.locationsKind
    if (kind !== null) {
      await kind.delete(id)
      return
    }
    await this.store.deleteWhere({
      collection: STORAGE_LOCATIONS,
      filter: { where: { id } },
    })
  }
}

export function locationToBody(loc: StorageLocation): StorageLocationBody {
  return {
    type: loc.type,
    displayName: loc.displayName,
    providerId: loc.providerId,
    config: { ...loc.config },
    isSystem: loc.isSystem,
    createdAt: loc.createdAt,
    updatedAt: loc.updatedAt,
    ...(loc.nodeId !== undefined ? { nodeId: loc.nodeId } : {}),
    ...(loc.enabled !== undefined ? { enabled: loc.enabled } : {}),
    ...(loc.mode !== undefined ? { mode: loc.mode } : {}),
  }
}

export function bodyToPersistedLocation(
  id: string,
  body: StorageLocationBody,
): PersistedStorageLocation | null {
  const parsedType = StorageLocationTypeSchema.safeParse(body.type)
  if (!parsedType.success || id.length === 0) return null
  return {
    id,
    type: parsedType.data,
    displayName: body.displayName,
    providerId: body.providerId,
    config: { ...body.config },
    ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...LegacyStorageLocationDefaultSchema.parse({ isDefault: body.isDefault ?? false }),
    isSystem: body.isSystem,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
  }
}

// ── Row ↔ record mapping ──────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readConfig(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return { ...raw }
  if (typeof raw === 'string' && raw.length > 0) return parseJsonObject(raw) ?? {}
  return {}
}

function mapLocationToRow(loc: StorageLocation): Record<string, unknown> {
  // Persist `nodeId` inside the `config` blob under the reserved key when
  // set; omit the key entirely when absent (node-agnostic providers).
  const storedConfig: Record<string, unknown> = { ...loc.config }
  if (loc.nodeId !== undefined) storedConfig[NODE_ID_CONFIG_KEY] = loc.nodeId
  // Written only when the caller has an opinion — an undefined flag stays
  // ABSENT on disk so it keeps reading back as "active".
  if (loc.enabled !== undefined) storedConfig[ENABLED_CONFIG_KEY] = loc.enabled
  // The typed state (D385). `enabled` above stays written for one release so an
  // interrupted deploy leaves rows an older build still reads correctly.
  if (loc.mode !== undefined) storedConfig[MODE_CONFIG_KEY] = loc.mode
  return {
    id: loc.id,
    type: loc.type,
    display_name: loc.displayName,
    provider_id: loc.providerId,
    config: storedConfig,
    // The `is_default` column is DEAD DATA (D383). It is still written —
    // always 0 — because the table declares it NOT NULL and an interrupted
    // deploy must leave rows an older build can still read; nothing reads it
    // back except the orchestrator's one boot migration.
    is_default: 0,
    is_system: loc.isSystem ? 1 : 0,
    created_at: loc.createdAt,
    updated_at: loc.updatedAt,
  }
}

/**
 * Decode a row read from the collection. Returns `null` when the row's `type`
 * fails the id-format schema or the row has no id — a corrupt row (hand-edited,
 * partial migration) is skipped rather than taking the boot read down with it.
 */
function mapRowToLocation(row: Record<string, unknown>): PersistedStorageLocation | null {
  const typeRaw = row['type']
  const parsedType = StorageLocationTypeSchema.safeParse(typeRaw)
  if (!parsedType.success) return null
  const type: StorageLocationType = parsedType.data

  const id = String(row['id'] ?? '')
  if (!id) return null

  // `config` is a JSON column, so the surface normally hands back a parsed
  // object. A STRING still arrives for rows written by an older build that
  // have not been rewritten since, and a corrupt one (hand-edited, partial
  // migration, …) must not lock the orchestrator out of boot — fall back to
  // an empty config and let the location be served with the provider's
  // defaults.
  const storedConfig = readConfig(row['config'])

  // Extract the reserved `nodeId` key (SP1) from the persisted blob and
  // strip it from the returned config — API consumers and the provider
  // see only provider-facing keys (`basePath`, `minFreePercent`, …).
  // Absent → field omitted (node-agnostic providers leave it unset).
  const nodeIdRaw = storedConfig[NODE_ID_CONFIG_KEY]
  const nodeId = typeof nodeIdRaw === 'string' && nodeIdRaw.length > 0 ? nodeIdRaw : undefined
  // Only a real boolean counts. Anything else (missing, null, a string written
  // by hand) reads as ABSENT → active, never as disabled: the failure mode of
  // guessing wrong here is a silently dead write target.
  const enabledRaw = storedConfig[ENABLED_CONFIG_KEY]
  const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : undefined
  // The typed state. Parsed, never cast: a value an older/newer build wrote
  // that is not one of the four reads as UNSTAMPED, and the boot migration
  // folds the legacy pair for it — never as a state nothing declared.
  const parsedMode = StorageLocationModeSchema.safeParse(storedConfig[MODE_CONFIG_KEY])
  const mode = parsedMode.success ? parsedMode.data : undefined
  const config: Record<string, unknown> = { ...storedConfig }
  delete config[NODE_ID_CONFIG_KEY]
  delete config[ENABLED_CONFIG_KEY]
  delete config[MODE_CONFIG_KEY]

  return {
    id,
    type,
    displayName: String(row['display_name'] ?? ''),
    providerId: String(row['provider_id'] ?? ''),
    config,
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(mode !== undefined ? { mode } : {}),
    // The retired default flag, read through the schema that DECLARES it
    // (never implicitly): a key dropped from a non-strict object is stripped in
    // silence, and the migration would then see "no legacy default" on every
    // hub (D380/D381). Only `attachStore`'s migration may consume it.
    ...LegacyStorageLocationDefaultSchema.parse({
      isDefault: row['is_default'] === 1 || row['is_default'] === true,
    }),
    isSystem: row['is_system'] === 1 || row['is_system'] === true,
    createdAt: Number(row['created_at'] ?? 0),
    updatedAt: Number(row['updated_at'] ?? 0),
  }
}
