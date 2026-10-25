/**
 * `device-manager:devices` — ONE ROW PER DEVICE.
 *
 * ## What this replaces
 *
 * The device-manager used to keep its whole fleet in three JSON blobs on the
 * addon-settings row set (`deviceMeta`, `deviceMetadata`, `deviceIndex`).
 * Measured on the live hub 2026-08-19: 467 KB + 87 KB + 70 KB = 625 KB of the
 * table's 627 KB, and EVERY read of any of them read and `JSON.parse`d all
 * three, synchronously, on hub-main's event loop — `ctx.settings.readAddonStore`
 * lands in `SqliteSettingsBackend.getAllAddon`, which is prefix-scoped to the
 * addon but not to the key. A V8 profile of that boot had hub-main's JS thread
 * 99.9% busy for 76 s with 64% of it inside `getAllAddon`, ~89% of that entered
 * through the meta store, and every runner's first store read queued behind it.
 *
 * Writing was worse than reading. `ConfigManager.createSettingsView`'s
 * `writeAddonStore` is `setAllAddon(addonId, { ...existing, ...patch })`, and
 * `setAllAddon` DELETEs and re-INSERTs every row of the addon — so renaming one
 * camera rewrote 625 KB.
 *
 * A row per device makes the per-device question a primary-key lookup and the
 * per-device write a single-row upsert touching only the columns named.
 *
 * ## Why `deviceIndex` has no column and no collection
 *
 * `deviceIndex` was `Record<addonId, stableId[]>` — pure derivation: `addonId`
 * and `stableId` are fields of every row, so "this addon's devices" is
 * `where: { addonId }`. It carried exactly one bit that is NOT derivable:
 * membership meant "`registerDevice` has run at least once", which is how
 * `registerDevice` tells a FIRST registration (emit `DeviceRegistered`) from a
 * meta refresh. `allocateDeviceId` writes a row without registering, so row
 * existence alone cannot answer it. That bit is the {@link registered} column,
 * and nothing else of `deviceIndex` survives.
 *
 * ## Why metadata is a column and not a second collection
 *
 * `deviceMetadata` lived in its own blob for ONE reason: a blob write is
 * whole-value, so a lifecycle writer (`registerDevice` / `setName` / …) that
 * had to preserve a `metadata` field would eventually clobber a concurrent
 * `setMetadata`. Single-writer-per-blob was the fix. Column writes have no such
 * problem — `set` names its columns and leaves the rest of the row untouched —
 * so the split has no reason to exist and metadata rides on the device's own
 * row.
 *
 * ## Adding a column later
 *
 * `declareCollection` is additive ONLY when SQLite can `ALTER TABLE … ADD
 * COLUMN` it. A new `NOT NULL` column without a `defaultValue` cannot be added
 * to a populated table, so the backend counts it as non-additive and REBUILDS
 * the collection — dropping every row. Any column added here after ship must
 * either be nullable or carry a `defaultValue`.
 */

import type {
  ChildLayout,
  CollectionColumn,
  CollectionIndex,
  DeviceDisplayOverride,
  IScopedLogger,
  MutationFilter,
  QueryFilter,
  SettingsRecord,
  SettingsStoreClient,
} from '@camstack/types'
import type { RetiredRowStore } from '../sqlite-storage/retired-settings-keys.js'
import type { PersistedDeviceMeta } from './device-meta-types.js'
import { FleetReadCensus } from './fleet-read-census.js'
import { MigrationRefusedError } from './migration-refused.js'

/**
 * @durable class=ledger owner=device-manager
 *   write="one row per device, written by `allocateDeviceId` (identity placeholder),
 *     `registerDevice` (full reconcile) and every meta setter (single-column patch);
 *     `setMetadata` patches the `metadata` column of the same row"
 *   retention="none — a row goes only when the operator removes the device
 *     (`removeDevice`), or when an integration is deleted and cascades. Bounded by the
 *     fleet an operator configures (974 rows on the reference hub)."
 *
 * ### Why `ledger` and not `config`
 *
 * This shipped as `class=registry`, a sixth class that does not exist —
 * `DURABLE_CLASSES` is `ledger | mirror | ephemeral | config | audit`, so
 * `check-durable-state-declared.ts` has failed since. `config` is the tempting
 * answer, because a device's `name` and `location` ARE operator intent. It is
 * the wrong one, and wrong in the dangerous direction: `config`'s rule is
 * *"already durable everywhere"*, and that is exactly the premise that made the
 * dead `devices` table look harmless right up to D183.
 *
 * Nothing else holds a device's NUMERIC id. `allocateDeviceId` mints it here
 * and every other store in the system keys on it — `addon-device-settings`,
 * `device-runtime-state`, every `pipeline-analytics:*` row, every recorder path.
 * That is `ledger`'s definition verbatim ("a fact only this component ever
 * held"), and `ledger`'s rule — *must not be pruned against a fallible read* —
 * is precisely the rule this collection needs (D49): a `getBindings` or an
 * integration listing that answers empty because it FAILED must never be
 * allowed to retire a device row.
 */
export const DEVICE_ROWS_COLLECTION = 'device-manager:devices'

/**
 * Fleet reads pass this explicitly.
 *
 * `settings-store.query` applies a DEFAULT row cap of 2 000 when the caller
 * names no `limit` (`query-bounds.ts`), and truncation there is silent to the
 * caller — it warns in the engine's log and returns a short list that looks
 * complete. The reference hub is already at 974 devices; half the default cap
 * is not a margin worth betting the fleet listing on. 20 000 is the engine's
 * hard ceiling, so this asks for everything the engine will ever serve in one
 * call and any future need to page is a loud failure rather than a quiet one.
 */
export const DEVICE_ROWS_FLEET_LIMIT = 20_000

export const DEVICE_ROWS_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER', notNull: true },
  { name: 'addonId', type: 'TEXT', notNull: true },
  { name: 'stableId', type: 'TEXT', notNull: true },
  { name: 'type', type: 'TEXT', notNull: true },
  { name: 'name', type: 'TEXT', notNull: true },
  { name: 'userNamed', type: 'BOOLEAN' },
  { name: 'location', type: 'TEXT' },
  { name: 'disabled', type: 'BOOLEAN', notNull: true, defaultValue: false },
  { name: 'parentDeviceId', type: 'INTEGER' },
  { name: 'registered', type: 'BOOLEAN', notNull: true, defaultValue: false },
  { name: 'features', type: 'JSON' },
  { name: 'exportFingerprint', type: 'TEXT' },
  { name: 'integrationId', type: 'TEXT' },
  { name: 'linkDeviceId', type: 'INTEGER' },
  { name: 'primaryChildEntityId', type: 'TEXT' },
  { name: 'childLayout', type: 'JSON' },
  { name: 'role', type: 'TEXT' },
  { name: 'display', type: 'JSON' },
  { name: 'metadata', type: 'JSON' },
]

/**
 * The columns a SLIM fleet read selects: every declared column except the
 * primary key (always returned) and `metadata`.
 *
 * ## Why this is a DENYLIST and must stay one
 *
 * `decodeDeviceRow` returns `null` when `deviceId`, `addonId`, `stableId`,
 * `type` or `name` is missing, and `list()` then SKIPS the row with a warn. A
 * hand-written allowlist that forgot one of the five would not make the fleet
 * slower — it would make devices vanish from every listing, quietly, and the
 * only trace would be a log line nobody is reading at the time. Deriving the
 * list by subtraction means a column added tomorrow is carried by default and
 * the only way to lose one is to name it here.
 *
 * `metadata` is the one slim provably discards: `device-queries.ts#listAll`
 * sets `metadata: null` on every slim row. It is also the largest JSON column
 * on the row, which is why this is worth doing at all.
 *
 * ## What is NOT here, and will not be
 *
 * There is no `where: { type: 'camera' }` companion to this. `isCameraDevice`
 * is a method-presence check (`getStreamSources`), not the persisted `type`, so
 * a doorbell with a camera answers YES while its row says `doorbell`. Filtering
 * the rows by type would strip exactly those devices of their row — and
 * `toDeviceInfo` reads `name` / `location` / `disabled` from the ROW precisely
 * because the live device's copies are stale by construction. The fleet would
 * keep working and start reporting pre-rename names on doorbells. The
 * `isCamera` filter stays in JS.
 */
export const DEVICE_ROWS_SLIM_COLUMNS: readonly string[] = DEVICE_ROWS_COLUMNS.map(
  (c) => c.name,
).filter((name) => name !== 'id' && name !== 'metadata')

export const DEVICE_ROWS_INDEXES: readonly CollectionIndex[] = [
  { name: 'idx_dm_devices_addon_stable', columns: ['addonId', 'stableId'] },
  { name: 'idx_dm_devices_parent', columns: ['parentDeviceId'] },
  { name: 'idx_dm_devices_integration', columns: ['integrationId'] },
]

/**
 * The settings-store door this store needs, as a plain object surface.
 *
 * The production door is the tRPC client on `ctx.api.settingsStore`
 * (`client.get.query(…)` / `client.set.mutate(…)`); {@link deviceRowBackendOf}
 * adapts it. Declaring the port separately is what lets a test hand over an
 * in-memory table without reconstructing a tRPC router, and it names exactly
 * the seven methods this store is allowed to reach for.
 */
export interface DeviceRowBackend {
  declareCollection(input: {
    collection: string
    columns: readonly CollectionColumn[]
    indexes?: readonly CollectionIndex[]
  }): Promise<void>
  get(input: { collection: string; key: string }): Promise<unknown>
  set(input: { collection: string; key: string; value: Record<string, unknown> }): Promise<void>
  query(input: {
    collection: string
    filter?: QueryFilter
  }): Promise<readonly SettingsRecord<Record<string, unknown>>[]>
  updateWhere(input: {
    collection: string
    filter: MutationFilter
    data: Record<string, unknown>
  }): Promise<{ updated: number }>
  delete(input: { collection: string; key: string }): Promise<void>
  count(input: { collection: string; filter?: QueryFilter }): Promise<number>
}

/** Adapt `ctx.api.settingsStore` (tRPC namespace) to {@link DeviceRowBackend}. */
export function deviceRowBackendOf(client: SettingsStoreClient): DeviceRowBackend {
  return {
    declareCollection: async (input) => {
      await client.declareCollection.mutate(input)
    },
    get: (input) => client.get.query(input),
    set: async (input) => {
      await client.set.mutate(input)
    },
    query: (input) => client.query.query(input),
    updateWhere: (input) => client.updateWhere.mutate(input),
    delete: async (input) => {
      await client.delete.mutate(input)
    },
    count: (input) => client.count.query(input),
  }
}

/**
 * The fields a single-column patch may set.
 *
 * Every key is OPTIONAL and only the keys PRESENT reach the `SET` list, so an
 * omitted key leaves that column exactly as it was. `null` is a real value and
 * CLEARS the column; it is how `setDisplay(null)` removes an override.
 *
 * A patch is an UPDATE, never an insert — see {@link DeviceRowStore.patch}.
 */
export interface DeviceRowPatch {
  readonly type?: string
  readonly name?: string
  readonly userNamed?: boolean
  readonly location?: string | null
  readonly disabled?: boolean
  readonly parentDeviceId?: number | null
  readonly registered?: boolean
  readonly features?: readonly string[]
  readonly exportFingerprint?: string
  readonly integrationId?: string | null
  readonly linkDeviceId?: number | null
  readonly primaryChildEntityId?: string | null
  readonly childLayout?: ChildLayout | null
  readonly role?: string | null
  readonly display?: DeviceDisplayOverride | null
  readonly metadata?: Record<string, unknown> | null
}

/**
 * Every column `registerDevice` writes.
 *
 * It is spelled out rather than reusing {@link DeviceRowPatch} because this
 * statement doubles as the INSERT for a device whose row does not exist yet
 * (`allocateDeviceId` is not on every path into `registerDevice`), and SQLite
 * checks `NOT NULL` on the insert attempt BEFORE the upsert clause gets to
 * intercept the primary-key conflict. Every `NOT NULL` column is therefore
 * required here, and the type is what keeps it that way.
 *
 * Columns NOT listed — `integrationId`, `linkDeviceId`, `primaryChildEntityId`,
 * `childLayout`, `role`, `display`, `metadata` — are not in the statement at
 * all, so re-registering preserves them. The blob shape had to re-state each
 * one to avoid clobbering it, and every field added since has been one more
 * spread somebody had to remember.
 */
export interface DeviceRegistrationRow {
  readonly deviceId: number
  readonly addonId: string
  readonly stableId: string
  readonly type: string
  readonly name: string
  readonly userNamed: boolean
  readonly location: string | null
  readonly disabled: boolean
  readonly parentDeviceId: number | null
  readonly registered: boolean
  readonly features: readonly string[]
  readonly exportFingerprint: string
}

/** A device row as this store hands it back: the meta record plus its metadata blob. */
export interface DeviceRow {
  readonly meta: PersistedDeviceMeta
  /** `null` when the device has no hardware-identity metadata. */
  readonly metadata: Record<string, unknown> | null
  /** Has `registerDevice` ever run for this device? (former `deviceIndex` membership) */
  readonly registered: boolean
}

/** What {@link DeviceRowStore.swapIds} resolved before its first write. */
interface SwapPlan {
  readonly rowA: DeviceRow
  readonly rowB: DeviceRow
  readonly childrenOfA: readonly number[]
  readonly childrenOfB: readonly number[]
}

// ── Row decoding ──────────────────────────────────────────────────────────

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1) return true
  if (value === 0) return false
  return undefined
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry)
  }
  return out
}

/**
 * Decode one stored row.
 *
 * Returns `null` for a row missing an identity field the rest of the system
 * treats as an invariant (`deviceId` / `addonId` / `stableId` / `type` /
 * `name`). A row like that cannot be projected into a `DeviceInfo` and taking
 * the whole fleet read down for it would be worse — the caller logs the skip.
 */
export function decodeDeviceRow(data: Record<string, unknown>): DeviceRow | null {
  const deviceId = readNumber(data['deviceId'])
  const addonId = readString(data['addonId'])
  const stableId = readString(data['stableId'])
  const type = readString(data['type'])
  const name = readString(data['name'])
  if (
    deviceId === undefined ||
    addonId === undefined ||
    stableId === undefined ||
    type === undefined ||
    name === undefined
  ) {
    return null
  }

  const location = readString(data['location'])
  const parentDeviceId = readNumber(data['parentDeviceId'])
  const userNamed = readBoolean(data['userNamed'])
  const features = readStringArray(data['features'])
  const exportFingerprint = readString(data['exportFingerprint'])
  const integrationId = readString(data['integrationId'])
  const linkDeviceId = readNumber(data['linkDeviceId'])
  const primaryChildEntityId = readString(data['primaryChildEntityId'])
  const role = readString(data['role'])
  const rawChildLayout = data['childLayout']
  const rawDisplay = data['display']
  const rawMetadata = data['metadata']

  // A SQL NULL is the ABSENT form of every optional field. The blob shape
  // distinguished `undefined` (never set) from an explicit `null` on
  // `linkDeviceId` / `role` / `primaryChildEntityId`; a column cannot, and no
  // reader ever branched between them — every consumer treats both as "no
  // link / no role / no override".
  const meta: PersistedDeviceMeta = {
    id: deviceId,
    addonId,
    stableId,
    type,
    name,
    location: location ?? null,
    disabled: readBoolean(data['disabled']) ?? false,
    parentDeviceId: parentDeviceId ?? null,
    ...(userNamed !== undefined ? { userNamed } : {}),
    ...(features !== undefined ? { features } : {}),
    ...(exportFingerprint !== undefined ? { exportFingerprint } : {}),
    ...(integrationId !== undefined ? { integrationId } : {}),
    ...(linkDeviceId !== undefined ? { linkDeviceId } : {}),
    ...(primaryChildEntityId !== undefined ? { primaryChildEntityId } : {}),
    ...(isChildLayout(rawChildLayout) ? { childLayout: rawChildLayout } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(isPlainObject(rawDisplay) ? { display: toDisplayOverride(rawDisplay) } : {}),
  }

  return {
    meta,
    metadata: isPlainObject(rawMetadata) ? rawMetadata : null,
    registered: readBoolean(data['registered']) ?? false,
  }
}

/**
 * `ChildLayout` is a JSON column: what comes back is whatever was written.
 * The projection hands it to the UI untouched, so the only thing worth
 * checking is that it is still the array shape the writer put in.
 */
function isChildLayout(value: unknown): value is ChildLayout {
  return Array.isArray(value)
}

/**
 * `DeviceDisplayOverride` is likewise stored verbatim in a JSON column. It is
 * an all-optional record, so any object round-trips; the write path
 * (`normalizeDisplayOverride`) is what gives it shape.
 */
function toDisplayOverride(value: Record<string, unknown>): DeviceDisplayOverride {
  return value
}

/** Full-row value for an upsert: identity + every field of the meta record. */
export function encodeDeviceRow(
  meta: PersistedDeviceMeta,
  extra: { readonly registered?: boolean; readonly metadata?: Record<string, unknown> | null } = {},
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: String(meta.id),
    deviceId: meta.id,
    addonId: meta.addonId,
    stableId: meta.stableId,
    type: meta.type,
    name: meta.name,
    userNamed: meta.userNamed ?? null,
    location: meta.location,
    disabled: meta.disabled,
    parentDeviceId: meta.parentDeviceId,
    registered: extra.registered ?? false,
    features: meta.features === undefined ? null : [...meta.features],
    exportFingerprint: meta.exportFingerprint ?? null,
    integrationId: meta.integrationId ?? null,
    linkDeviceId: meta.linkDeviceId ?? null,
    primaryChildEntityId: meta.primaryChildEntityId ?? null,
    childLayout: meta.childLayout ?? null,
    role: meta.role ?? null,
    display: meta.display ?? null,
  }
  if (extra.metadata !== undefined) row['metadata'] = extra.metadata
  return row
}

/** Column map for a partial write — only the keys the caller actually named. */
export function encodeDeviceRowPatch(patch: DeviceRowPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    row[key] = value
  }
  return row
}

// ── The store ─────────────────────────────────────────────────────────────

/**
 * Row access for the device fleet. Every method is a single statement against
 * `device-manager:devices` — there is no in-memory copy of the fleet here and
 * no cache: a per-device question is a primary-key lookup, a fleet question is
 * one indexed scan.
 */
export class DeviceRowStore {
  private declared: Promise<void> | null = null

  /** Call-site attribution for fleet reads. Armed only by
   *  `CAMSTACK_FLEET_READ_CENSUS_MS`; see `fleet-read-census.ts`. */
  private readonly census: FleetReadCensus

  /**
   * Is the fleet-read census armed right now? Exposed so a caller ABOVE this
   * store (`device-queries.ts`) can skip extracting a caller identity off its
   * input entirely when nobody is measuring — "the boolean field read first"
   * pattern this repo already uses elsewhere to keep a diagnostic seam at
   * zero cost while disarmed.
   */
  get censusArmed(): boolean {
    return this.census.armed
  }

  constructor(
    private readonly backend: DeviceRowBackend,
    private readonly logger: IScopedLogger,
    census?: FleetReadCensus,
  ) {
    this.census =
      census ?? new FleetReadCensus(process.env['CAMSTACK_FLEET_READ_CENSUS_MS'], Date.now())
    if (this.census.armed) {
      const startedAt = Date.now()
      setTimeout(
        () => this.census.report(this.logger, Date.now() - startedAt),
        this.census.windowMs,
      ).unref?.()
    }
  }

  /**
   * Lazy, idempotent `declareCollection`, memoised on the PROMISE so N
   * concurrent first-callers issue one declaration rather than N. A rejection
   * is not latched — the slot is cleared so the next caller retries instead of
   * inheriting a dead collection forever.
   */
  async declare(): Promise<void> {
    const existing = this.declared
    if (existing !== null) return existing
    const run = (async (): Promise<void> => {
      try {
        await this.backend.declareCollection({
          collection: DEVICE_ROWS_COLLECTION,
          columns: DEVICE_ROWS_COLUMNS,
          indexes: DEVICE_ROWS_INDEXES,
        })
      } catch (err) {
        this.declared = null
        throw err
      }
    })()
    this.declared = run
    return run
  }

  /** One device, by numeric id. `null` when the fleet does not know it. */
  async get(deviceId: number): Promise<DeviceRow | null> {
    await this.declare()
    const raw = await this.backend.get({
      collection: DEVICE_ROWS_COLLECTION,
      key: String(deviceId),
    })
    if (!isPlainObject(raw)) return null
    const decoded = decodeDeviceRow(raw)
    if (decoded === null) {
      this.logger.warn('device row skipped — identity fields missing', { tags: { deviceId } })
      return null
    }
    return decoded
  }

  /**
   * Every device, ordered by numeric id.
   *
   * `callerAddonId`, when known, is the addon that ORIGINATED this call —
   * captured off the cap-channel envelope (`CapCallInput.callerAddonId`, set
   * by `LocalChildRegistry` from the registered `childId`), never guessed.
   * Passed straight to the census; a stack walk can never name it (see
   * `fleet-read-census.ts#siteOf`).
   */
  async listAll(callerAddonId?: string): Promise<readonly DeviceRow[]> {
    return this.list(
      {
        orderBy: { field: 'deviceId', direction: 'asc' },
        limit: DEVICE_ROWS_FLEET_LIMIT,
      },
      undefined,
      callerAddonId,
    )
  }

  /**
   * The fleet, read as narrowly as the question allows.
   *
   * `listAll` is a full-table `SELECT … ORDER BY "deviceId"` — ~1 017 rows a
   * call on the live hub, 14–54 calls a minute — and its callers then filtered
   * the result in JS. The two filters that CAN be pushed down are here:
   *
   *  - `deviceIds` becomes a `whereIn`. The viewer's linked-devices panel asks
   *    about ~8 named ids; it was answered by reading the whole ledger. An
   *    EMPTY set reads nothing at all rather than degrading to "everything" —
   *    a request for no devices is a request, not an omission.
   *  - `slim` becomes a column projection, {@link DEVICE_ROWS_SLIM_COLUMNS}.
   *
   * `isCamera` is deliberately NOT one of them — see that constant's note and
   * `device-row-store-filtered.spec.ts`.
   *
   * `callerAddonId` — see {@link listAll}'s doc; same meaning here.
   */
  async listFleet(
    opts: {
      readonly deviceIds?: readonly number[]
      readonly slim?: boolean
    },
    callerAddonId?: string,
  ): Promise<readonly DeviceRow[]> {
    if (opts.deviceIds !== undefined && opts.deviceIds.length === 0) return []
    return this.list(
      {
        ...(opts.deviceIds !== undefined
          ? { whereIn: { deviceId: [...new Set(opts.deviceIds)] } }
          : {}),
        orderBy: { field: 'deviceId', direction: 'asc' },
        limit: DEVICE_ROWS_FLEET_LIMIT,
      },
      opts.slim === true ? DEVICE_ROWS_SLIM_COLUMNS : undefined,
      callerAddonId,
    )
  }

  /**
   * Many devices, by numeric id, in ONE query.
   *
   * `get(id)` called once per id in a loop is the primary-key lookup this
   * store exists to make cheap, repeated until it isn't — measured on the
   * live hub 2026-08-25: `get device-manager:devices` at 1 656 calls/min
   * steady-state and 17 687 during boot, exactly one row per call. This
   * collapses that into the same `whereIn` {@link listFleet} already does for
   * a fleet read, keyed by id.
   *
   * A requested id the fleet does not know is simply ABSENT from the map —
   * never a fabricated row, matching {@link get}'s `null`. An empty `ids`
   * reads nothing at all, same as `listFleet({ deviceIds: [] })`.
   */
  async getMany(ids: readonly number[]): Promise<ReadonlyMap<number, DeviceRow>> {
    const rows = await this.listFleet({ deviceIds: ids })
    return new Map(rows.map((row) => [row.meta.id, row]))
  }

  /**
   * The device an addon knows as `stableId`, or `null`.
   *
   * `(addonId, stableId)` is the addon-facing identity — unique by
   * construction, since `allocateDeviceId` is the only thing that mints a row
   * and it returns the existing id for a pair it already knows. A second row
   * for the pair would be a corruption, so this takes the LOWEST id and says
   * so rather than picking arbitrarily.
   */
  async findByStableId(addonId: string, stableId: string): Promise<DeviceRow | null> {
    const rows = await this.list({
      where: { addonId, stableId },
      orderBy: { field: 'deviceId', direction: 'asc' },
      limit: 2,
    })
    const first = rows[0]
    if (first === undefined) return null
    if (rows.length > 1) {
      this.logger.warn('duplicate device rows for one (addonId, stableId) — using the lowest id', {
        tags: { deviceId: first.meta.id },
        meta: { addonId, stableId, ids: rows.map((r) => r.meta.id) },
      })
    }
    return first
  }

  /** Every device owned by one addon, ordered by numeric id. */
  async listByAddon(addonId: string): Promise<readonly DeviceRow[]> {
    return this.list({
      where: { addonId },
      orderBy: { field: 'deviceId', direction: 'asc' },
      limit: DEVICE_ROWS_FLEET_LIMIT,
    })
  }

  /** Every device an integration owns, ordered by numeric id. */
  async listByIntegration(integrationId: string): Promise<readonly DeviceRow[]> {
    return this.list({
      where: { integrationId },
      orderBy: { field: 'deviceId', direction: 'asc' },
      limit: DEVICE_ROWS_FLEET_LIMIT,
    })
  }

  /** Direct children of one device, ordered by numeric id. */
  async listByParent(parentDeviceId: number): Promise<readonly DeviceRow[]> {
    return this.list({
      where: { parentDeviceId },
      orderBy: { field: 'deviceId', direction: 'asc' },
      limit: DEVICE_ROWS_FLEET_LIMIT,
    })
  }

  /**
   * Direct children of MANY devices, in ONE query.
   *
   * `listByParent` called once per parent is the same shape `get` was before
   * {@link getMany}: an indexed lookup this store makes cheap, repeated until
   * it isn't. Measured on the live hub 2026-08-27, 120-second boot window:
   * `DeviceRowStore.list < DeviceRowStore.listByParent < getChildren` at
   * **1 024 calls** — one per device — for 919 rows in total. The BFS in
   * `device-meta-actions.ts#collectDescendants` walked a container tree the
   * same way, one query per node.
   *
   * `whereIn` on the indexed `parentDeviceId` column collapses a level of that
   * walk into a single statement. Contract, verbatim from {@link getMany}: an
   * EMPTY `parentDeviceIds` reads nothing at all rather than degrading to
   * "everything", and a parent with no children — or one the fleet does not
   * know — is simply ABSENT from the map, never an invented empty row.
   */
  async listByParentMany(
    parentDeviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, readonly DeviceRow[]>> {
    const out = new Map<number, readonly DeviceRow[]>()
    const unique = [...new Set(parentDeviceIds)]
    if (unique.length === 0) return out
    const rows = await this.list({
      whereIn: { parentDeviceId: unique },
      orderBy: { field: 'deviceId', direction: 'asc' },
      limit: DEVICE_ROWS_FLEET_LIMIT,
    })
    const byParent = new Map<number, DeviceRow[]>()
    for (const row of rows) {
      const parent = row.meta.parentDeviceId
      if (parent === null || parent === undefined) continue
      const bucket = byParent.get(parent)
      if (bucket === undefined) byParent.set(parent, [row])
      else bucket.push(row)
    }
    for (const [parent, bucket] of byParent) out.set(parent, bucket)
    return out
  }

  /** How many devices the fleet holds. Used to tell "empty store" from "gone device". */
  async count(): Promise<number> {
    await this.declare()
    return this.backend.count({ collection: DEVICE_ROWS_COLLECTION })
  }

  private async list(
    filter: QueryFilter,
    columns?: readonly string[],
    callerAddonId?: string,
  ): Promise<readonly DeviceRow[]> {
    // Attribution, when armed — captured BEFORE the first `await`.
    //
    // ⚠ This line was below `await this.declare()` in the first version, and
    // that one statement blinded the measurement it exists for: an await severs
    // the synchronous stack, so every captured site came back rooted at
    // `processTicksAndRejections` and named `listAll` without ever naming who
    // CALLED `listAll`. The 2026-08-26 boot census answered half the question
    // for exactly this reason.
    //
    // The OTHER half — the 5 001-call row that named `listAll` and nothing
    // above it, even with the stack fixed — is not a depth problem: a call
    // that arrived over the cap channel passes through generic dispatcher
    // code no matter which addon sent it, so no stack would ever show the
    // caller. `callerAddonId`, when the transport captured one, is used
    // VERBATIM instead — see `fleet-read-census.ts#siteOf`.
    //
    // Disarmed this is one method call returning `null` and a comparison — see
    // `fleet-read-census.ts` for why the seam is permanent and the capture is
    // not, and why it arms from the environment rather than from a debug action
    // (the storm being investigated is at BOOT, before any action could reach
    // this process).
    const site = this.census.siteOf(callerAddonId)
    await this.declare()
    const records = await this.backend.query({
      collection: DEVICE_ROWS_COLLECTION,
      filter,
      ...(columns === undefined ? {} : { columns }),
    })
    this.census.record(site, records.length)
    const out: DeviceRow[] = []
    for (const record of records) {
      const decoded = decodeDeviceRow(record.data)
      if (decoded === null) {
        // A skipped row is a device that disappears from every listing. Silence
        // here reads as "the device was removed", which is the one thing it is not.
        this.logger.warn('device row skipped — identity fields missing', {
          meta: { rowId: record.id },
        })
        continue
      }
      out.push(decoded)
    }
    return out
  }

  /** Insert or replace the whole identity row. */
  async upsert(
    meta: PersistedDeviceMeta,
    extra: {
      readonly registered?: boolean
      readonly metadata?: Record<string, unknown> | null
    } = {},
  ): Promise<void> {
    await this.declare()
    await this.backend.set({
      collection: DEVICE_ROWS_COLLECTION,
      key: String(meta.id),
      value: encodeDeviceRow(meta, extra),
    })
  }

  /**
   * Write the named columns of an EXISTING row and nothing else.
   *
   * An UPDATE, deliberately not an upsert: a partial upsert would try to INSERT
   * a row carrying only the patched columns, and SQLite rejects that on the
   * `NOT NULL` identity columns before the primary-key conflict can turn it
   * into an update. Every caller resolves the row under the write lock and
   * throws when it is gone, so matching zero rows means a device was removed
   * between the resolve and the write — the patch is lost, and a lost write
   * that says nothing reads as a write that happened.
   */
  async patch(deviceId: number, patch: DeviceRowPatch): Promise<void> {
    const columns = encodeDeviceRowPatch(patch)
    if (Object.keys(columns).length === 0) return
    await this.declare()
    const { updated } = await this.backend.updateWhere({
      collection: DEVICE_ROWS_COLLECTION,
      filter: { where: { id: String(deviceId) } },
      data: columns,
    })
    if (updated === 0) {
      this.logger.warn('device row patch matched no row — the device was removed under it', {
        tags: { deviceId },
        meta: { columns: Object.keys(columns) },
      })
    }
  }

  /**
   * Insert-or-update the registration columns. See {@link DeviceRegistrationRow}
   * for why this is a separate, fully-specified statement rather than a patch.
   */
  async upsertRegistration(row: DeviceRegistrationRow): Promise<void> {
    await this.declare()
    await this.backend.set({
      collection: DEVICE_ROWS_COLLECTION,
      key: String(row.deviceId),
      value: {
        deviceId: row.deviceId,
        addonId: row.addonId,
        stableId: row.stableId,
        type: row.type,
        name: row.name,
        userNamed: row.userNamed,
        location: row.location,
        disabled: row.disabled,
        parentDeviceId: row.parentDeviceId,
        registered: row.registered,
        features: [...row.features],
        exportFingerprint: row.exportFingerprint,
      },
    })
  }

  /** Drop the device's row. Idempotent. */
  /**
   * Exchange the ids of two devices, carrying their children with them.
   *
   * ## Why this exists as a primitive
   *
   * Replacing a camera means the new hardware has to become the device the rest
   * of the system already knows. Everything general about a camera is keyed on
   * the NUMERIC id and on nothing else — the recording path on disk is
   * `<deviceId>/profile/…`, the hour ledger, the media store and zone ownership
   * carry `deviceId` and not one `stableId` between them, and all four
   * ecosystem exports (Home Assistant, Alexa, HomeKit, Google) key on it too.
   * Moving that work is the expensive, lossy operation. Moving the NUMBER is
   * two rows.
   *
   * ## Children are re-pointed, not renumbered
   *
   * A child keeps its own id and follows its parent: every row whose
   * `parentDeviceId` was `a` now names `b`, and the reverse. Renumbering the
   * children as well would move THEIR general work for no reason — the
   * accessory's own recordings and rules are keyed on the child id, which is
   * not the id being inherited.
   *
   * ## There are no transactions here, so the ORDER is the safety
   *
   * The backing store is a collection API (`set` / `delete` / `updateWhere`);
   * there is no rollback to lean on. So the sequence is chosen to make every
   * crash point LOUD rather than plausible: `a` first moves to a freshly
   * allocated id, which the monotonic counter guarantees was never used and
   * will never be reused. A crash before the end therefore leaves a device
   * missing from its number and a stray at an unfamiliar one — visible in the
   * device list at a glance. What it can never leave is two rows on one number,
   * or a row that looks correct while its children point elsewhere.
   *
   * The caller holds {@link DeviceMetaStore.withMetaWriteLock}. This method does
   * not take it: taking it here would deadlock the migration that has to disable
   * functions on both devices in the same critical section.
   */
  async swapIds(a: number, b: number, tempId: number): Promise<void> {
    // Everything before the first write is a PRECHECK: a refusal or a failed
    // read there moved nothing, and says so with a MigrationRefusedError — the
    // migration then restores both cameras' switches instead of leaving them
    // off as it must when rows may have moved.
    const plan = await this.planSwap(a, b, tempId).catch((err: unknown) => {
      if (err instanceof MigrationRefusedError) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new MigrationRefusedError(
        `[device-manager] swapIds: precheck failed before any row moved — ${detail}`,
        { cause: err },
      )
    })
    const { rowA, rowB, childrenOfA, childrenOfB } = plan

    await this.moveRow(rowA, tempId)
    await this.moveRow(rowB, a)
    await this.moveRow({ ...rowA, meta: { ...rowA.meta, id: tempId } }, b)

    for (const childId of childrenOfA) await this.patch(childId, { parentDeviceId: b })
    for (const childId of childrenOfB) await this.patch(childId, { parentDeviceId: a })

    this.logger.info('device ids swapped', {
      tags: { deviceId: a },
      meta: { a, b, childrenOfA, childrenOfB },
    })
  }

  /** The read-only half of {@link swapIds}: every refusal, every read, no write. */
  private async planSwap(a: number, b: number, tempId: number): Promise<SwapPlan> {
    // The prechecks write nothing: each is a MigrationRefusedError, so the
    // migration restores both cameras' switches instead of leaving them off.
    if (a === b) {
      throw new MigrationRefusedError(`[device-manager] swapIds: ${a} and ${b} are the same device`)
    }
    await this.declare()
    const rowA = await this.get(a)
    const rowB = await this.get(b)
    if (rowA === null) {
      throw new MigrationRefusedError(`[device-manager] swapIds: device ${a} does not exist`)
    }
    if (rowB === null) {
      throw new MigrationRefusedError(`[device-manager] swapIds: device ${b} does not exist`)
    }
    if ((await this.get(tempId)) !== null) {
      throw new MigrationRefusedError(`[device-manager] swapIds: temp id ${tempId} is taken`)
    }

    // Resolved up front so the write phase is a straight line with no reads
    // interleaved. NOT for the reason it looks like: a child is untouched by
    // its parent changing number, so `listByParent` answers the same either
    // side of the moves — asserted by putting the resolve after them, which
    // stays green. The comment said otherwise until that disarm caught it.
    const childrenOfA = (await this.listByParent(a)).map((r) => r.meta.id)
    const childrenOfB = (await this.listByParent(b)).map((r) => r.meta.id)
    return { rowA, rowB, childrenOfA, childrenOfB }
  }

  /** Rewrite a row under a new id and drop the old key. Not exported: the only
   *  legitimate reason to move a row is {@link swapIds}. */
  private async moveRow(row: DeviceRow, toId: number): Promise<void> {
    await this.upsert(
      { ...row.meta, id: toId },
      {
        registered: row.registered,
        metadata: row.metadata,
      },
    )
    await this.remove(row.meta.id)
  }

  async remove(deviceId: number): Promise<void> {
    await this.declare()
    await this.backend.delete({ collection: DEVICE_ROWS_COLLECTION, key: String(deviceId) })
  }

  /**
   * The retirement door for the three blobs this collection replaced.
   *
   * The purge is gated on THIS collection being non-empty, and the count has to
   * be taken after `declare()` — which is why the owning addon runs it and the
   * settings engine cannot: at the engine's own boot no addon has declared
   * anything, so every successor would read as unreadable, forever.
   */
  retiredRowStore(): RetiredRowStore {
    return {
      hasRow: async (spec) => {
        const raw = await this.backend.get({ collection: spec.collection, key: spec.row })
        return raw !== undefined && raw !== null
      },
      deleteRow: async (spec) => {
        await this.backend.delete({ collection: spec.collection, key: spec.row })
      },
      countRows: async (collection) => {
        await this.declare()
        return this.backend.count({ collection })
      },
    }
  }
}
