/**
 * Test helpers for addon-pipeline-analytics.
 *
 * Provides:
 *  - `makeFakeSettingsStore` — tRPC-shaped in-memory `SettingsStoreClient`.
 *    Backs declared collections in a `Map<collection, Map<id, data>>` and
 *    supports the filter predicates the stores actually use (`where` +
 *    `whereIn` + `whereBetween` + `orderBy` + `limit`).
 *  - `makeFakeStorageProvider` — in-memory `IStorageProvider` keyed by
 *    `location:relativePath`. `read` / `write` / `delete` / `exists` work
 *    against a `Map<string, Buffer>`.
 *  - `makeFakeDeviceManager` — tRPC-shaped `getBindings` procedure used
 *    by `BindingCache`. Exposes `setActive(deviceId, capName, active)` to
 *    seed the state for tests.
 *  - `makeFakeEventBus` — local pub/sub identical to the orchestrator
 *    helper's implementation (glob `*` / `.**` / `.*` patterns supported).
 *  - `makeSilentLogger` — IScopedLogger no-op.
 *  - `makeFakeAddonApi` — wires the settings-store + device-manager
 *    stubs onto an `AddonApi` shape that `BindingCache` + the stores
 *    consume.
 */
import { DeviceType } from '@camstack/types'
import type {
  AddonApi,
  DeviceInfo,
  EventFilter,
  IEventBus,
  IScopedLogger,
  IStorageProvider,
  LogExtras,
  SettingsStoreClient,
  SystemEvent,
  TopologyNode,
} from '@camstack/types'
import {
  cosineSimilarity,
  decodeVectorBase64,
  type VectorFilter,
  type VectorMetadata,
  vectorDimFromBase64,
  vectorIndexDimConflictError,
} from '@camstack/types'
import type { RecordsAccess } from '@camstack/types'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { makeAnalyticsRecords, type FakeRecords } from './fake-records.js'

export type { FakeRecords } from './fake-records.js'
import { AUDIO_EVENTS_COLLECTION, MOTION_EVENTS_COLLECTION } from '../store/event-store.js'
import { FACES_COLLECTION } from '../store/face-store.js'
import { PLATES_COLLECTION } from '../store/plate-store.js'
import { SENSOR_EVENTS_COLLECTION } from '../store/sensor-event-store.js'
import { KEYFRAME_NATIVE_MAX_WIDTH } from '../pipeline/key-frame-capture.js'
import { EmbeddingVectorIndex } from '../store/embedding-vector-index.js'

// ── Logger ──────────────────────────────────────────────────────────

/**
 * A log RECORDER, typed — no cast, and not a bespoke logger interface: it
 * hands out a real {@link IScopedLogger} and keeps what was written to it.
 * `entries` is what the per-window summary assertions read.
 */
export interface LogRecorder {
  readonly logger: IScopedLogger
  readonly entries: Array<{
    level: 'debug' | 'info' | 'warn' | 'error'
    message: string
    extras?: LogExtras
  }>
}

export function makeLogRecorder(): LogRecorder {
  const entries: LogRecorder['entries'] = []
  const push =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, extras?: LogExtras): void => {
      entries.push({ level, message, ...(extras !== undefined ? { extras } : {}) })
    }
  const logger: IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, entries }
}

/** Default model pins for {@link FaceGalleryProvider} specs. */
export const testFaceGalleryModelPins = {
  resolveClusterModelId: async (): Promise<string> => 'arcface-r100',
  resolveAutoAssignThreshold: async (): Promise<number> => 0.5,
} as const

/** Minimal {@link TopologyNode} for topology snapshot specs. */
export function makeTestTopologyNode(
  patch: Pick<TopologyNode, 'id' | 'isOnline'> & Partial<TopologyNode>,
): TopologyNode {
  return {
    name: patch.id,
    hostname: patch.id,
    platform: 'linux',
    arch: 'x64',
    cpuModel: null,
    cpuCores: 4,
    memoryMB: 8192,
    engines: [],
    isHub: patch.isHub ?? false,
    cpuPercent: 0,
    memoryPercent: 0,
    uptime: 0,
    lastSeen: new Date(0).toISOString(),
    localIps: [],
    addons: [],
    processes: [],
    categories: [],
    rootPackage: null,
    ...patch,
  }
}

/** Record kinds the addon declares during `initialize()` — required on hub boot specs. */
export async function makePipelineBootRecords(): Promise<RecordsAccess> {
  return (await makeAnalyticsRecords()).records
}

/** Hub boot specs that assert on persisted ledger rows need the fake transport tables. */
export async function makePipelineBootRecordsWorld(): Promise<FakeRecords> {
  return makeAnalyticsRecords()
}

/** The ledger collections these boot specs read and seed, by records kind. */
const LEDGER_KIND_BY_COLLECTION: Readonly<Record<string, string>> = {
  [MOTION_EVENTS_COLLECTION]: 'motion-events',
  [AUDIO_EVENTS_COLLECTION]: 'audio-events',
  [SENSOR_EVENTS_COLLECTION]: 'sensor-events',
  [FACES_COLLECTION]: 'faces',
  [PLATES_COLLECTION]: 'plates',
}

function ledgerKindOf(collection: string): string {
  const kind = LEDGER_KIND_BY_COLLECTION[collection]
  if (kind === undefined) throw new Error(`no records kind mapped for ${collection}`)
  return kind
}

/** One stored row in the shape its store wrote it: the body, with the header's device and clock. */
function legacyShaped(row: {
  readonly deviceId: number | null
  readonly at: number | null
  readonly data: Record<string, unknown>
}): Record<string, unknown> {
  return {
    ...row.data,
    ...(row.deviceId !== null ? { deviceId: row.deviceId } : {}),
    ...(row.at !== null ? { timestamp: row.at } : {}),
  }
}

/** The persisted rows of a ledger collection (`ctx.records`, every node). */
export function tracklessEventRows(input: {
  readonly records: FakeRecords
  readonly collection: string
}): readonly Record<string, unknown>[] {
  const table = input.records.tables.get(ledgerKindOf(input.collection))
  return [...(table?.values() ?? [])].map(legacyShaped)
}

/** The same rows with their ids. */
export function phase5LedgerEntries(input: {
  readonly records: FakeRecords
  readonly collection: string
}): readonly { readonly id: string; readonly data: Record<string, unknown> }[] {
  const table = input.records.tables.get(ledgerKindOf(input.collection))
  return [...(table?.entries() ?? [])].map(([id, row]) => ({ id, data: legacyShaped(row) }))
}

/**
 * Seed ledger rows as the ledger's writer stores them: `deviceId` and the
 * `timestamp` clock in the header AND in the body (a kind's indexes read the
 * body), every other field in the body.
 */
export function seedTracklessEvents(
  records: FakeRecords,
  collection: string,
  rows: readonly CollectionRecord[],
): void {
  const kind = ledgerKindOf(collection)
  for (const row of rows) {
    const deviceId = row.data['deviceId']
    const at = row.data['timestamp']
    const data: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row.data)) {
      if (key === 'id') continue
      data[key] = value
    }
    records.seed(kind, {
      id: row.id,
      ...(typeof deviceId === 'number' ? { deviceId } : {}),
      ...(typeof at === 'number' ? { at } : {}),
      data,
    })
  }
}

export function makeSilentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** Vitest spies (or partial stubs) merged onto {@link makeSilentLogger} — fills `withTags` / `child`. */
export function mergeSilentLogger(patch: Partial<IScopedLogger>): IScopedLogger {
  const base = makeSilentLogger()
  const logger: IScopedLogger = {
    ...base,
    ...patch,
    child: patch.child ?? base.child,
    withTags: patch.withTags ?? base.withTags,
  }
  return logger
}

/** Minimal {@link DeviceInfo} row for `deviceManager.listAll` stubs. */
export function makeTestDeviceInfo(
  patch: Partial<DeviceInfo> & Pick<DeviceInfo, 'id'>,
): DeviceInfo {
  const id = patch.id
  return {
    stableId: `stable-${id}`,
    addonId: 'test-addon',
    type: DeviceType.Camera,
    name: `device-${id}`,
    location: null,
    disabled: false,
    parentDeviceId: null,
    online: true,
    features: [],
    isCamera: true,
    config: {},
    ...patch,
    id,
  }
}

// ── Event bus ───────────────────────────────────────────────────────

export interface FakeEventBus {
  readonly bus: IEventBus
  readonly captured: SystemEvent[]
}

export function makeFakeEventBus(): FakeEventBus {
  const captured: SystemEvent[] = []
  const handlers = new Map<string, Set<(event: SystemEvent) => void>>()

  const matches = (pattern: string, category: string): boolean => {
    if (pattern === '*' || pattern === '**') return true
    if (pattern.endsWith('.**')) return category.startsWith(pattern.slice(0, -3))
    if (pattern.endsWith('.*')) return category.startsWith(pattern.slice(0, -2))
    return pattern === category
  }

  const extractPattern = (filter: EventFilter | string): string => {
    if (typeof filter === 'string') return filter
    if (filter && typeof filter === 'object' && 'category' in filter) {
      const cat = filter.category
      if (typeof cat === 'string') return cat
      if (Array.isArray(cat) && cat.length > 0) return String(cat[0])
    }
    return '*'
  }

  const bus: IEventBus = {
    emit(event: SystemEvent) {
      captured.push(event)
      for (const [pattern, set] of handlers) {
        if (matches(pattern, event.category)) {
          for (const h of set) h(event)
        }
      }
    },
    subscribe(filter: EventFilter | string, handler: (event: SystemEvent) => void) {
      const pattern = extractPattern(filter)
      const existing = handlers.get(pattern)
      if (existing) existing.add(handler)
      else handlers.set(pattern, new Set([handler]))
      return () => {
        handlers.get(pattern)?.delete(handler)
      }
    },
    getRecent() {
      return captured as readonly SystemEvent[]
    },
  }

  return { bus, captured }
}

// ── Settings store (declareCollection + insert/query/delete) ────────

interface CollectionRecord {
  id: string
  data: Record<string, unknown>
}

interface Filter {
  where?: Record<string, unknown>
  whereIn?: Record<string, unknown[]>
  whereJsonArrayAny?: Record<string, unknown[]>
  whereBetween?: Record<string, [unknown, unknown]>
  /** NULL-safe exclusion, mirroring the compiled `IS NULL OR !=` semantics. */
  whereNot?: Record<string, unknown>
  /** NULL-safe exclusion of a SET, mirroring `(IS NULL OR NOT IN (…))`. */
  whereNotIn?: Record<string, unknown[]>
  orderBy?: { field: string; direction: 'asc' | 'desc' }
  limit?: number
  offset?: number
}

/**
 * A row's value for a filter field, with SQLite's own conflation applied: a
 * column the row never wrote is NULL, not `undefined`. Without this, a fake
 * seeded from partial objects disagrees with production about the one
 * population an `IS NULL` filter exists to find.
 */
function fieldValue(record: CollectionRecord, field: string): unknown {
  if (field === 'id') return record.id
  const value = record.data[field]
  return value === undefined ? null : value
}

function applyFilter(records: readonly CollectionRecord[], filter?: Filter): CollectionRecord[] {
  let out = [...records]
  if (filter?.where) {
    for (const [k, v] of Object.entries(filter.where)) {
      // `null` is `IS NULL`, mirroring `compileFilter`. It used to compile to
      // `= NULL`, which is NULL for every row — the filter matched nothing and
      // the count reported it as an answer.
      out = out.filter((r) => fieldValue(r, k) === v)
    }
  }
  if (filter?.whereNot) {
    for (const [k, v] of Object.entries(filter.whereNot)) {
      out = out.filter((r) => {
        const val = fieldValue(r, k)
        // `null` is `IS NOT NULL`; any other value keeps NULL rows (they
        // predate the column) and excludes only the exact match.
        if (v === null) return val !== null
        return val === null || val !== v
      })
    }
  }
  if (filter?.whereNotIn) {
    for (const [k, arr] of Object.entries(filter.whereNotIn)) {
      // Empty is "nothing excluded", never "matches nothing" — the compiler
      // skips the predicate entirely.
      if (arr.length === 0) continue
      const hasNull = arr.includes(null)
      const set = new Set(arr.filter((v) => v !== null))
      out = out.filter((r) => {
        const val = fieldValue(r, k)
        if (val === null) return !hasNull
        return !set.has(val)
      })
    }
  }
  if (filter?.whereIn) {
    for (const [k, arr] of Object.entries(filter.whereIn)) {
      const set = new Set(arr)
      out = out.filter((r) => set.has(k === 'id' ? r.id : r.data[k]))
    }
  }
  if (filter?.whereJsonArrayAny) {
    for (const [k, arr] of Object.entries(filter.whereJsonArrayAny)) {
      if (arr.length === 0) continue
      const set = new Set(arr)
      out = out.filter((r) => {
        const val = r.data[k]
        // Mirrors the SQL: a column that is absent or not an array KEEPS its
        // row. This is a superset prefilter — it must never be the reason an
        // answer loses something.
        if (!Array.isArray(val)) return true
        return val.some((v) => set.has(v))
      })
    }
  }
  if (filter?.whereBetween) {
    for (const [k, [lo, hi]] of Object.entries(filter.whereBetween)) {
      out = out.filter((r) => {
        const val = (k === 'id' ? r.id : r.data[k]) as number
        return val >= (lo as number) && val <= (hi as number)
      })
    }
  }
  if (filter?.orderBy) {
    const { field, direction } = filter.orderBy
    out.sort((a, b) => {
      const av = (field === 'id' ? a.id : a.data[field]) as number | string
      const bv = (field === 'id' ? b.id : b.data[field]) as number | string
      if (av === bv) return 0
      const cmp = av < bv ? -1 : 1
      return direction === 'asc' ? cmp : -cmp
    })
  }
  if (filter?.offset !== undefined) out = out.slice(filter.offset)
  if (filter?.limit !== undefined) out = out.slice(0, filter.limit)
  return out
}

/**
 * How many round trips a caller spent, per method.
 *
 * A store call is an RPC in production, and "the answer was right" says
 * nothing about whether it took two calls or six thousand. The `eventMedia`
 * migration gate returned the correct number and still timed out at 60 s,
 * because it paged 1.25 M rows at 200 per call — a shape no assertion about
 * the RESULT can see.
 */
export interface FakeStoreCallCounts {
  query: number
  count: number
  aggregate: number
  histogram: number
  /**
   * Single-row UPSERTs (`set`). The counter that separates a bulk stamp from a
   * per-row one: the event-media seal rewrote every column of one row per
   * round trip, and at ~2.3 rows/s the half-million-row stamp it exists to
   * perform needed two and a half days. Nothing about the rows it produced can
   * see that; only this can.
   */
  set: number
  /** Bulk `UPDATE … WHERE` statements. */
  updateWhere: number
  /**
   * Rows `query` has MATERIALISED into the process so far — the sum of every
   * result-set length, not the number of calls.
   *
   * Round trips alone cannot see the difference between a walk that pages at
   * 200 and one that pages at 100 000; both are "few calls" and both drag the
   * whole table across an RPC boundary and through V8. This counter is the one
   * an aggregate drives to ZERO: `SUM`/`COUNT`/`GROUP BY` answer without
   * materialising a single row, and no assertion about the returned NUMBER can
   * tell that apart from a walk that summed correctly.
   */
  rowsRead: number
}

/**
 * Make a round trip FAIL, per method.
 *
 * "What does this caller report when the store cannot answer?" is a question
 * every consumer of a number owes an answer to, and it cannot be asked of a
 * fake that always succeeds. Set a field to a message and every subsequent
 * call to that method rejects with it; set it back to `null` to recover.
 */
export interface FakeStoreFaults {
  query: string | null
  set: string | null
  count: string | null
  aggregate: string | null
  histogram: string | null
  updateWhere: string | null
  /**
   * Make `updateWhere` match NOTHING and report it as success — the exact
   * shape D312 was written about.
   *
   * `where: { locationId: null }` used to compile to `"locationId" = ?` with
   * NULL bound, which SQL three-valued logic makes NULL for every row: the
   * statement touched no rows and returned without error. A caller that loops
   * "probe, then stamp what the probe found" against that backend never
   * terminates, and one that does not loop reports a completed seal having
   * stamped nothing. Not reachable through a thrown fault, so it gets its own
   * switch.
   */
  updateWhereMatchesNothing: boolean
}

export interface FakeSettingsStore {
  readonly client: SettingsStoreClient
  readonly declared: Set<string>
  /** `database` hint from each `declareCollection` (absent = settings). */
  readonly declaredDatabase: Map<string, string>
  readonly data: Map<string, Map<string, Record<string, unknown>>>
  /** Round trips made through {@link FakeSettingsStore.client} so far. */
  readonly calls: FakeStoreCallCounts
  /** Injected read failures — see {@link FakeStoreFaults}. */
  readonly faults: FakeStoreFaults
  /** Direct seeding for arrange steps. */
  seed(collection: string, records: readonly CollectionRecord[]): void
  /** Raw count for assertions. */
  size(collection: string): number
}

/** The part of a declared column this fake models. */
interface DeclaredColumn {
  name: string
  type?: string
  defaultValue?: unknown
  primaryKey?: boolean
}

export interface FakeSettingsStoreOptions {
  /**
   * Drop keys that no declared column can hold, exactly as the real backend
   * does (`sqlite-settings-backend.ts`: `if (decl.columns.has(k))` — no error,
   * no warning, the value is simply gone).
   *
   * OFF by default because most specs here seed rows directly and would have to
   * declare every field they use. ON is what a spec asking "does this field
   * actually PERSIST?" needs: with it off, the fake is a permissive bag and
   * happily returns a value production wrote into the void. That is not
   * hypothetical — `ObjectEvent.frameId` was stamped on every event, read back
   * by the slim projection, documented in the cap, and had no column. Nothing
   * failed; it just never arrived.
   */
  readonly enforceDeclaredColumns?: boolean
}

/**
 * The shared in-memory settings store. Its read boundary mirrors the SQLite
 * backend's `decodeColumnValue` on every read verb, `get` included: booleans,
 * declared defaults, and TEXT that starts with `[` / `{` handed back DECODED
 * (follow-up 102; `fake-settings-store-json-parity.spec.ts` holds it to the
 * real engine).
 *
 * Known gaps vs the real backend (follow-up 102 review, L2/L3) — a spec whose
 * answer depends on one of these must run over the real engine
 * (`*-over-real-sqlite.spec.ts`):
 *  - a declared column holding nothing is ABSENT from a read row; the backend
 *    returns it as `null`;
 *  - the write side's `serializeColumnValue` is not modelled: an object comes
 *    back as the SAME reference (aliasing) instead of a fresh copy, and a
 *    `Buffer` / `Date` comes back as itself instead of `{type:'Buffer',…}` /
 *    an ISO string;
 *  - SQLite type affinity is not modelled: a number written into a TEXT column
 *    reads back a number (the engine: a string), a numeric string in an
 *    INTEGER column reads back a string (the engine: a number);
 *  - indexes, query plans and constraints (`NOT NULL`, `UNIQUE`) do not exist.
 */
export function makeFakeSettingsStore(options: FakeSettingsStoreOptions = {}): FakeSettingsStore {
  const calls: FakeStoreCallCounts = {
    query: 0,
    count: 0,
    aggregate: 0,
    histogram: 0,
    set: 0,
    updateWhere: 0,
    rowsRead: 0,
  }
  const faults: FakeStoreFaults = {
    query: null,
    set: null,
    count: null,
    aggregate: null,
    histogram: null,
    updateWhere: null,
    updateWhereMatchesNothing: false,
  }
  const declared = new Set<string>()
  const declaredDatabase = new Map<string, string>()
  const data = new Map<string, Map<string, Record<string, unknown>>>()
  /** Per-collection `column → defaultValue`, captured at declare time. */
  const defaults = new Map<string, ReadonlyMap<string, unknown>>()
  /** Per-collection declared column NAMES — only consulted when enforcing. */
  const columnNames = new Map<string, ReadonlySet<string>>()

  /** The backend's undeclared-key drop, opt-in. See the option's doc. */
  const dropUndeclared = (
    collection: string,
    record: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (options.enforceDeclaredColumns !== true) return record
    const cols = columnNames.get(collection)
    if (cols === undefined) return record
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(record)) {
      if (cols.has(k)) out[k] = v
    }
    return out
  }

  /**
   * Per-collection BOOLEAN columns, captured at declare time. The real
   * backend serialises booleans to `0|1` at the write boundary and decodes
   * them back on read (`decodeColumnValue`), so a stored value is never a JS
   * boolean and a read value never a raw `0|1`. The fake mirrors both
   * boundaries; without this, a `NOT NULL DEFAULT 0` boolean column would
   * compare a materialised `0` against a filter's `false` and miss — the
   * fake diverging from production exactly where the retention predicate
   * (D81) lives.
   */
  const boolCols = new Map<string, ReadonlySet<string>>()

  const encodeBooleans = (
    collection: string,
    record: Record<string, unknown>,
  ): Record<string, unknown> => {
    const cols = boolCols.get(collection)
    if (!cols || cols.size === 0) return record
    let out: Record<string, unknown> | null = null
    for (const name of cols) {
      const v = record[name]
      if (typeof v === 'boolean') {
        out ??= { ...record }
        out[name] = v ? 1 : 0
      }
    }
    return out ?? record
  }

  const decodeBooleans = (
    collection: string,
    record: Record<string, unknown>,
  ): Record<string, unknown> => {
    const cols = boolCols.get(collection)
    if (!cols || cols.size === 0) return record
    let out: Record<string, unknown> | null = null
    for (const name of cols) {
      const v = record[name]
      if (v === undefined) continue
      out ??= { ...record }
      out[name] = v !== 0 && v !== '0' && v !== false
    }
    return out ?? record
  }

  /** Collections whose primary key is an `INTEGER` rowid alias. */
  const autoKeyCollections = new Set<string>()

  /**
   * The key an insert with no supplied id gets.
   *
   * A NUMBER on a rowid-alias collection — one past the highest numeric key in
   * the table, which is what SQLite does for an `INTEGER PRIMARY KEY` — and a
   * uuid string otherwise.
   */
  const nextKeyFor = (
    collection: string,
    rows: Map<string, Record<string, unknown>>,
  ): string | number => {
    if (!autoKeyCollections.has(collection)) return randomUUID()
    let max = 0
    for (const key of rows.keys()) {
      const n = Number(key)
      if (Number.isInteger(n) && n > max) max = n
    }
    return max + 1
  }

  const ensureCollection = (collection: string): Map<string, Record<string, unknown>> => {
    let m = data.get(collection)
    if (!m) {
      m = new Map()
      data.set(collection, m)
    }
    return m
  }

  /**
   * Apply the declared column DEFAULTS to a row that has no value for them.
   *
   * This models what the real backend does and a naive Map cannot: a column
   * added to an existing table lands as `ALTER TABLE … ADD COLUMN … NOT NULL
   * DEFAULT <v>`, and SQLite materialises that default for every row already on
   * disk. A fake that left the field `undefined` would make a filter like
   * `where: { markForTrain: false }` miss every historical row — the opposite
   * of production, and in the direction that turns a retention predicate into
   * an immortality bug nobody's test would have shown.
   */
  const withDefaults = (
    collection: string,
    record: Record<string, unknown>,
  ): Record<string, unknown> => {
    const cols = defaults.get(collection)
    if (!cols || cols.size === 0) return record
    let out: Record<string, unknown> | null = null
    for (const [name, value] of cols) {
      if (record[name] === undefined) {
        out ??= { ...record }
        out[name] = value
      }
    }
    return out ?? record
  }

  /**
   * The backend's JSON read boundary (`sqlite-settings-backend.ts`
   * `decodeColumnValue`): a TEXT value that starts with `[` or `{` comes back
   * ALREADY PARSED (and as written when it does not parse). A store that wrote
   * `JSON.stringify(x)` into a column reads `x`, never the string — and one
   * that ran `JSON.parse(String(value))` on it threw on every row in
   * production while this fake handed the string back untouched (follow-up
   * 102: no promoted tape was ever listed).
   */
  const decodeJsonText = (record: Record<string, unknown>): Record<string, unknown> => {
    let out: Record<string, unknown> | null = null
    for (const [name, v] of Object.entries(record)) {
      if (typeof v !== 'string' || !(v.startsWith('{') || v.startsWith('['))) continue
      let decoded: unknown
      try {
        decoded = JSON.parse(v)
      } catch {
        continue
      }
      out ??= { ...record }
      out[name] = decoded
    }
    return out ?? record
  }

  const records = (collection: string): CollectionRecord[] => {
    const m = data.get(collection)
    if (!m) return []
    return Array.from(m.entries()).map(([id, record]) => ({
      id,
      data: decodeJsonText(decodeBooleans(collection, withDefaults(collection, record))),
    }))
  }

  // Cast through unknown since the real generated client type has deep
  // namespace fields (get, set, count, isEmpty, update) we don't need
  // here. The shape matches the subset the stores actually call.
  const client = {
    declareCollection: {
      mutate: async (input: {
        collection: string
        database?: string
        columns?: readonly DeclaredColumn[]
      }) => {
        declared.add(input.collection)
        declaredDatabase.set(input.collection, input.database ?? 'settings')
        ensureCollection(input.collection)
        const withDefault = new Map<string, unknown>()
        const booleans = new Set<string>()
        const names = new Set<string>()
        for (const col of input.columns ?? []) {
          if (col.defaultValue !== undefined) withDefault.set(col.name, col.defaultValue)
          if (col.type === 'BOOLEAN') booleans.add(col.name)
          names.add(col.name)
        }
        defaults.set(input.collection, withDefault)
        boolCols.set(input.collection, booleans)
        columnNames.set(input.collection, names)
        // An `INTEGER PRIMARY KEY` is a ROWID ALIAS: SQLite assigns it and the
        // caller supplies nothing (D474). The fake has to model that or a
        // store that forgot to read the returned id would still pass here —
        // which is the exact shape of green-on-a-real-bug this repo has been
        // bitten by twice.
        const auto = (input.columns ?? []).some(
          (col) => col.primaryKey === true && col.type === 'INTEGER',
        )
        if (auto) autoKeyCollections.add(input.collection)
        else autoKeyCollections.delete(input.collection)
      },
    },
    insert: {
      /**
       * Returns the id the row ACTUALLY got, exactly as the cap does: the one
       * supplied, the ROWID assigned on an `INTEGER` primary key, or a minted
       * uuid on a TEXT one.
       */
      mutate: async (input: {
        collection: string
        record: { id?: string; data: Record<string, unknown> }
      }) => {
        const rows = ensureCollection(input.collection)
        const key = input.record.id ?? nextKeyFor(input.collection, rows)
        rows.set(
          typeof key === 'number' ? String(key) : key,
          dropUndeclared(input.collection, encodeBooleans(input.collection, input.record.data)),
        )
        return { id: key }
      },
    },
    /**
     * Slot upsert (D482) — the fake has to MODEL the slot or a store whose
     * conflict target is wrong still passes here.
     *
     * `conflict` names the columns that identify the slot. A row already
     * holding those exact values is UPDATED IN PLACE and keeps its id; nothing
     * matching is inserted and assigned one. That is the only behaviour the
     * media store's idempotence rests on: get it wrong in the fake and a
     * re-capture silently duplicates in production while the suite is green —
     * the exact shape of green-on-a-live-bug this repo has been bitten by
     * three times. (`media-slot-idempotence-over-real-sqlite.spec.ts` asserts
     * the same properties against the REAL engine, because a fake can never
     * prove anything about an index.)
     */
    upsert: {
      mutate: async (input: {
        collection: string
        conflict: readonly string[]
        record: { id?: string; data: Record<string, unknown> }
      }) => {
        const rows = ensureCollection(input.collection)
        const encoded = dropUndeclared(
          input.collection,
          encodeBooleans(input.collection, input.record.data),
        )
        const slotOf = (row: Record<string, unknown>): string =>
          input.conflict.map((col) => String(row[col])).join('\u0000')
        const wanted = slotOf(encoded)
        for (const [existingId, existingRow] of rows) {
          if (slotOf(existingRow) !== wanted) continue
          rows.set(existingId, { ...existingRow, ...encoded })
          // The id the row HAS, which on an auto-key collection is a number.
          return { id: autoKeyCollections.has(input.collection) ? Number(existingId) : existingId }
        }
        const key = input.record.id ?? nextKeyFor(input.collection, rows)
        rows.set(typeof key === 'number' ? String(key) : key, encoded)
        return { id: key }
      },
    },
    /**
     * Batch slot upsert (a composite-key collection is written this way, D871):
     * the same slot semantics as `upsert`, one call, all or nothing, and a
     * batch whose records do not all carry the same columns is refused whole —
     * the engine's rule, so a writer that varies its column set fails here.
     */
    upsertMany: {
      mutate: async (input: {
        collection: string
        conflict: readonly string[]
        records: readonly { id?: string; data: Record<string, unknown> }[]
      }) => {
        const rows = ensureCollection(input.collection)
        const shape = (r: { data: Record<string, unknown> }): string =>
          Object.keys(r.data).sort().join(',')
        const first = input.records[0]
        if (first !== undefined && input.records.some((r) => shape(r) !== shape(first))) {
          throw new Error('upsertMany: a heterogeneous batch is refused whole')
        }
        const slotOf = (row: Record<string, unknown>): string =>
          input.conflict.map((col) => String(row[col])).join('\u0000')
        const staged = new Map(rows)
        for (const record of input.records) {
          const encoded = dropUndeclared(
            input.collection,
            encodeBooleans(input.collection, record.data),
          )
          const wanted = slotOf(encoded)
          let placed = false
          for (const [existingId, existingRow] of staged) {
            if (slotOf(existingRow) !== wanted) continue
            staged.set(existingId, { ...existingRow, ...encoded })
            placed = true
            break
          }
          if (!placed) {
            const key = record.id ?? nextKeyFor(input.collection, staged)
            staged.set(typeof key === 'number' ? String(key) : key, encoded)
          }
        }
        rows.clear()
        for (const [k, v] of staged) rows.set(k, v)
        return { upserted: input.records.length }
      },
    },
    /**
     * `transact` — guard read, then every op, all or nothing: a snapshot of the
     * touched collections is restored when an op throws, the observable
     * contract of the engine's single SQLite transaction. The guard reads the
     * row WITH its column defaults, as the engine does (a pre-revision row is
     * `0`, not `undefined`).
     */
    transact: {
      mutate: async (input: {
        guard?: { collection: string; key: string; column: string; equals: unknown }
        ops: readonly (
          | { op: 'deleteWhere'; collection: string; filter?: Filter }
          | {
              op: 'insertMany'
              collection: string
              records: readonly { id?: string; data: Record<string, unknown> }[]
            }
          | { op: 'update'; collection: string; id: string; data: Record<string, unknown> }
        )[]
      }) => {
        if (input.guard !== undefined) {
          const row = data.get(input.guard.collection)?.get(input.guard.key)
          const current =
            row === undefined
              ? undefined
              : decodeBooleans(input.guard.collection, withDefaults(input.guard.collection, row))[
                  input.guard.column
                ]
          if (row === undefined || current !== input.guard.equals) {
            return { applied: false, current }
          }
        }
        const snapshot = new Map(
          [...data.entries()].map(([name, rows]) => [name, new Map(rows)] as const),
        )
        try {
          for (const op of input.ops) {
            if (op.op === 'deleteWhere') {
              const doomed = applyFilter(records(op.collection), op.filter)
              for (const row of doomed) data.get(op.collection)?.delete(row.id)
            } else if (op.op === 'insertMany') {
              const rows = ensureCollection(op.collection)
              for (const record of op.records) {
                const key = record.id ?? nextKeyFor(op.collection, rows)
                const id = typeof key === 'number' ? String(key) : key
                if (rows.has(id)) throw new Error(`duplicate key ${id} in ${op.collection}`)
                rows.set(
                  id,
                  dropUndeclared(op.collection, encodeBooleans(op.collection, record.data)),
                )
              }
            } else {
              const rows = ensureCollection(op.collection)
              rows.set(op.id, {
                ...rows.get(op.id),
                ...encodeBooleans(op.collection, op.data),
              })
            }
          }
        } catch (err) {
          data.clear()
          for (const [name, rows] of snapshot) data.set(name, rows)
          throw err
        }
        return { applied: true }
      },
    },
    update: {
      mutate: async (input: { collection: string; id: string; data: Record<string, unknown> }) => {
        const m = ensureCollection(input.collection)
        const existing = m.get(input.id) ?? {}
        m.set(input.id, { ...existing, ...encodeBooleans(input.collection, input.data) })
      },
    },
    delete: {
      mutate: async (input: { collection: string; key: string }) => {
        data.get(input.collection)?.delete(input.key)
      },
    },
    /**
     * Bulk delete — matched through the SAME `applyFilter` the fake's `query`
     * uses, so a filter that selects a row for reading selects it for deletion
     * too. A fake that matched differently here would let a caller's filter be
     * wrong in production while passing in tests, which is precisely the shape
     * of bug this repo has been bitten by (a fake supplying what production
     * forgot to fetch).
     */
    deleteWhere: {
      mutate: async (input: { collection: string; filter?: Filter }) => {
        const doomed = applyFilter(records(input.collection), input.filter)
        const m = data.get(input.collection)
        for (const row of doomed) m?.delete(row.id)
        return { deleted: doomed.length }
      },
    },
    /**
     * Bulk update — `data` is MERGED onto every matching row, exactly as
     * `UPDATE … SET col = ?` leaves the columns it does not name alone. A fake
     * that replaced the row would let a caller ship a stamp that wiped every
     * other column and still pass.
     *
     * Matched through the same `applyFilter` as `query` and `deleteWhere`, so a
     * predicate that selects a row for reading selects it for writing too.
     */
    updateWhere: {
      mutate: async (input: {
        collection: string
        filter?: Filter
        data: Record<string, unknown>
      }) => {
        calls.updateWhere++
        if (faults.updateWhere !== null) throw new Error(faults.updateWhere)
        if (faults.updateWhereMatchesNothing) return { updated: 0 }
        const hit = applyFilter(records(input.collection), input.filter)
        const m = ensureCollection(input.collection)
        for (const row of hit) {
          const existing = m.get(row.id) ?? {}
          m.set(row.id, {
            ...existing,
            ...dropUndeclared(input.collection, encodeBooleans(input.collection, input.data)),
          })
        }
        return { updated: hit.length }
      },
    },
    /**
     * Reads, with the SQL-level column projection applied — the fake drops the
     * unrequested keys exactly as the engine declines to SELECT them.
     *
     * A fake that ignored `columns` would hand every caller the whole row, and
     * a store method that projected away a column it still reads would pass
     * here and return a track with no trajectory in production. That is the
     * failure mode this file already warns about two methods up; a projection
     * is the sharpest version of it, because the wrong answer is a plausible
     * value rather than a crash.
     */
    query: {
      query: async (input: {
        collection: string
        filter?: Filter
        columns?: readonly string[]
      }) => {
        calls.query++
        if (faults.query !== null) throw new Error(faults.query)
        const rows = applyFilter(records(input.collection), input.filter)
        calls.rowsRead += rows.length
        if (input.columns === undefined) return rows
        const declaredCols = columnNames.get(input.collection)
        if (input.columns.length === 0) {
          throw new Error(`empty column projection on "${input.collection}"`)
        }
        const keep = new Set<string>()
        for (const name of input.columns) {
          if (name === 'id') continue
          if (declaredCols !== undefined && !declaredCols.has(name)) {
            throw new Error(
              `query on "${input.collection}" asked to read "${name}", which is not a column of this collection`,
            )
          }
          keep.add(name)
        }
        return rows.map((r) => {
          const data: Record<string, unknown> = { id: r.id }
          for (const k of keep) {
            // `?? null`, not "skip when absent": the engine SELECTs the column
            // and a row with no value for it comes back NULL, present. Only a
            // column that was NOT PROJECTED is missing. A fake that omitted
            // both would let a reader treat "the database says nothing" and "I
            // did not ask" as the same thing — which is the exact distinction
            // the projection contract exists to keep.
            data[k] = r.data[k] ?? null
          }
          return { id: r.id, data }
        })
      },
    },
    count: {
      query: async (input: { collection: string; filter?: Filter }) => {
        calls.count++
        if (faults.count !== null) throw new Error(faults.count)
        return applyFilter(records(input.collection), input.filter).length
      },
    },
    /**
     * `COUNT(*)` plus one SUM/MIN/MAX per requested field, over the rows the
     * filter selects — the fake mirror of the backend's single-statement
     * aggregate.
     *
     * It REFUSES an unresolvable field, exactly as the engine does
     * (`sqlite-settings-backend.ts`: "answering without it would return a
     * number that looks real"). A fake that quietly answered `null` for a
     * mistyped column would let a store method ship a footprint of zero bytes
     * and pass here — which is the precise failure this repo has already paid
     * for on a DROPPED PREDICATE, and the reason the engine treats a dropped
     * FIELD as fatal.
     *
     * `null` is NO ROW MATCHED, never zero: `AggregateResultSchema` draws that
     * distinction and a caller that renders "0 bytes" for "nothing here" is
     * reporting a lie about a disk.
     */
    aggregate: {
      query: async (input: {
        collection: string
        fields: readonly { as: string; field: string; op: 'sum' | 'min' | 'max' }[]
        filter?: Filter
      }) => {
        calls.aggregate++
        if (faults.aggregate !== null) throw new Error(faults.aggregate)
        const declaredCols = columnNames.get(input.collection)
        for (const f of input.fields) {
          if (declaredCols !== undefined && !declaredCols.has(f.field)) {
            throw new Error(
              `aggregate cannot read "${f.field}" on "${input.collection}" — it is not a column of this collection, and answering without it would return a number that looks real`,
            )
          }
        }
        const rows = applyFilter(records(input.collection), input.filter)
        const values: Record<string, number | null> = {}
        for (const f of input.fields) {
          let acc: number | null = null
          for (const r of rows) {
            const raw = r.data[f.field]
            if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
            if (acc === null) acc = f.op === 'sum' ? 0 : raw
            acc =
              f.op === 'sum' ? acc + raw : f.op === 'min' ? Math.min(acc, raw) : Math.max(acc, raw)
          }
          values[f.as] = acc
        }
        return { count: rows.length, values }
      },
    },
    histogram: {
      query: async (input: {
        collection: string
        field: string
        bucketSize: number
        origin: number
        filter?: Filter
      }) => {
        calls.histogram++
        if (faults.histogram !== null) throw new Error(faults.histogram)
        const rows = applyFilter(records(input.collection), input.filter)
        const counts = new Map<number, number>()
        for (const r of rows) {
          const raw = r.data[input.field]
          if (typeof raw !== 'number') continue
          const bucket = Math.floor((raw - input.origin) / input.bucketSize)
          counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
        }
        return Array.from(counts.entries())
          .toSorted((a, b) => a[0] - b[0])
          .map(([bucket, count]) => ({ bucket, count }))
      },
    },
    /**
     * A structured (multi-column) collection's row is decoded exactly like a
     * `query` row — booleans, declared defaults, JSON text — as the backend's
     * `get` runs `decodeColumnValue` on every column (fix round 1, review M1).
     * A KV collection (`['data']` only) stores the value whole and hands it
     * back as it was set, as the backend does after parsing its `data` blob.
     */
    get: {
      query: async (input: { collection: string; key: string }) => {
        const record = data.get(input.collection)?.get(input.key)
        if (record === undefined) return undefined
        const cols = columnNames.get(input.collection)
        const kv = cols === undefined || (cols.size === 1 && cols.has('data'))
        if (kv) return record
        return decodeJsonText(
          decodeBooleans(input.collection, withDefaults(input.collection, record)),
        )
      },
    },
    set: {
      mutate: async (input: { collection: string; key: string; value: unknown }) => {
        calls.set++
        if (faults.set !== null) throw new Error(faults.set)
        ensureCollection(input.collection).set(input.key, input.value as Record<string, unknown>)
      },
    },
    isEmpty: {
      query: async (input: { collection: string }) => {
        return (data.get(input.collection)?.size ?? 0) === 0
      },
    },
  } as unknown as SettingsStoreClient

  return {
    client,
    declared,
    declaredDatabase,
    data,
    calls,
    faults,
    seed(collection, recs) {
      const m = ensureCollection(collection)
      for (const r of recs) m.set(r.id, r.data)
    },
    size(collection) {
      return data.get(collection)?.size ?? 0
    },
  }
}

// ── Storage provider ────────────────────────────────────────────────

export interface FakeStorageProvider extends IStorageProvider {
  readonly files: Map<string, Buffer>
  /**
   * Every blob `read` this provider served, in order, as `location:relativePath`.
   *
   * The load-bearing observable for read amplification: a media listing that
   * ANSWERS with one row is not cheap if it opened six blobs to get there, and
   * asserting on the returned rows cannot tell the two apart — which is exactly
   * why `get-event-media-kind-filter.spec.ts` stayed green while the `kind`
   * filter was applied only after every blob had been read and base64'd.
   */
  readonly reads: string[]
}

export function makeFakeStorageProvider(): FakeStorageProvider {
  const files = new Map<string, Buffer>()
  const reads: string[] = []
  const keyFor = (location: string, relativePath: string) => `${location}:${relativePath}`
  const provider: FakeStorageProvider = {
    id: 'fake',
    name: 'fake',
    supportedLocations: ['data', 'recordings', 'cache', 'eventMedia'] as const,
    files,
    reads,
    resolve: async ({ location, relativePath }) => keyFor(location, relativePath),
    write: async ({ location, relativePath, data }) => {
      if (data instanceof Buffer) {
        files.set(keyFor(location, relativePath), Buffer.from(data))
      } else {
        // ReadableStream path not used by MediaStore tests — fail loud
        throw new Error('fake storage: stream input not supported in tests')
      }
    },
    read: async ({ location, relativePath }) => {
      reads.push(keyFor(location, relativePath))
      const buf = files.get(keyFor(location, relativePath))
      if (!buf) throw new Error(`fake storage: no file at ${keyFor(location, relativePath)}`)
      return buf
    },
    exists: async ({ location, relativePath }) => files.has(keyFor(location, relativePath)),
    list: async ({ location, prefix }) => {
      const needle = `${location}:${prefix ?? ''}`
      return Array.from(files.keys())
        .filter((k) => k.startsWith(needle))
        .map((k) => k.slice(location.length + 1))
    },
    delete: async ({ location, relativePath }) => {
      files.delete(keyFor(location, relativePath))
    },
    getAvailableSpace: async () => null,
  }
  return provider
}

// ── Device-manager stub (getBindings for BindingCache) ──────────────

/** One entry of the linked set a camera answers with. */
export interface FakeLinkedDevice {
  readonly deviceId: number
  readonly name: string
  /** The tracked-events opt-in; absent ⇒ produces (the device-manager default). */
  readonly producesTrackedEvents?: boolean
}

export interface FakeDeviceManager {
  readonly api: Pick<AddonApi, 'deviceManager'>
  setActive(deviceId: number, capName: string, active: boolean): void
  getActive(deviceId: number, capName: string): boolean
  /**
   * Declare `cameraId` a camera and give it a linked set — what
   * `LinkedCamerasCache` builds its reverse index from. Without this the
   * camera enumeration is empty and every sensor event resolves to
   * `no-camera`, which is indistinguishable from a working drop.
   */
  setLinkedCamera(cameraId: number, linked: readonly FakeLinkedDevice[]): void
}

export function makeFakeDeviceManager(): FakeDeviceManager {
  const state = new Map<number, Set<string>>()
  const linked = new Map<number, readonly FakeLinkedDevice[]>()

  const setActive = (deviceId: number, capName: string, active: boolean) => {
    const set = state.get(deviceId) ?? new Set<string>()
    if (active) set.add(capName)
    else set.delete(capName)
    state.set(deviceId, set)
  }

  const getActive = (deviceId: number, capName: string) =>
    state.get(deviceId)?.has(capName) ?? false

  const setLinkedCamera = (cameraId: number, devices: readonly FakeLinkedDevice[]) => {
    linked.set(cameraId, devices)
  }

  const devicesFor = (
    cameraId: number,
  ): readonly {
    deviceId: number
    name: string
    location: null
    features: readonly string[]
    producesTrackedEvents?: boolean
  }[] =>
    (linked.get(cameraId) ?? []).map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      location: null,
      features: [],
      ...(d.producesTrackedEvents !== undefined
        ? { producesTrackedEvents: d.producesTrackedEvents }
        : {}),
    }))

  const api = {
    deviceManager: {
      getBindings: {
        query: async (input: { deviceId: number }) => {
          const set = state.get(input.deviceId) ?? new Set<string>()
          return {
            deviceId: input.deviceId,
            entries: Array.from(set).map((capName) => ({
              capName,
              kind: 'wrapped' as const,
              providerAddonId: 'test',
              providerNodeId: 'hub',
              nativeAddonId: '',
            })),
          }
        },
      },
      listAll: {
        query: async () => [...linked.keys()].map((id) => ({ id, isCamera: true })),
      },
      getLinkedDevices: {
        query: async (input: { deviceId: number }) => ({
          mode: 'auto' as const,
          devices: devicesFor(input.deviceId),
        }),
      },
      getLinkedDevicesBatch: {
        query: async (input: { deviceIds: number[] }) =>
          input.deviceIds.map((deviceId) => ({ deviceId, devices: devicesFor(deviceId) })),
      },
    },
  } as unknown as Pick<AddonApi, 'deviceManager'>

  return { api, setActive, getActive, setLinkedCamera }
}

// ── Fake AddonApi (settingsStore + deviceManager) ───────────────────

export function makeFakeAddonApi(deps: {
  readonly settingsStore: SettingsStoreClient
  readonly deviceManager: FakeDeviceManager['api']['deviceManager']
  /**
   * Omit for a throwaway in-memory vector store nobody inspects (production
   * always has one, so the addon never boots without it). Supply one to READ
   * what the addon wrote.
   */
  readonly vectorStore?: ReturnType<typeof makeFakeVectorStore>['client']
  /**
   * Omit to boot WITHOUT a pixel source: no media is ever captured (what most
   * of these specs want). Supply one to exercise the real native-fetch path —
   * the ONLY way to test the key-frame capture end to end, since every pixel in
   * this addon arrives through `pipelineRunner.getNativeCrop`.
   */
  readonly pipelineRunner?: FakePipelineRunner
  /**
   * Omit to boot WITHOUT a snapshot cap: motion-event stills are skipped
   * (null fetch). Supply one to exercise the videoclip thumbnail path.
   */
  readonly snapshot?: {
    getSnapshot: {
      query: (input: {
        deviceId: number
        force?: boolean
      }) => Promise<{ base64: string; contentType: string } | null>
    }
  }
  /**
   * Omit to boot with NO `integrations` namespace at all — the alarm panel's
   * first port call then rejects immediately, which is the friendly failure.
   * Supply one to reproduce the UNfriendly one: `integrations` is a hub-CORE
   * namespace served by `$core-caps`, which `main.ts` registers only AFTER
   * `app.init()` returns, so during a child's boot the call is not slow but
   * structurally unanswerable and burns the full UDS timeout (D167).
   */
  readonly integrations?: FakeIntegrationsNamespace
  /**
   * Omit to boot WITHOUT an executor: the confirmation gate then has no
   * re-detector and fails open on every birth. Supply one to exercise the
   * gate's re-detection — the crop goes in, classes and boxes come back.
   */
  readonly pipelineExecutor?: FakePipelineExecutor
  /**
   * Omit to boot WITHOUT a `notificationOutput` namespace (the target catalog
   * read then rejects). Supply one for a spec that SAVES a rule through the
   * cap provider, whose referential check reads the live target catalog.
   */
  readonly notificationOutput?: unknown
  /** Omit for the default no-op device-history door (D850). */
  readonly deviceHistory?: AddonApi['deviceHistory']
  /**
   * What `storageMigration.moverClearance` answers. Omit and every mover is
   * cleared (no repoint is running); supply one to model a repoint that holds
   * the root.
   */
  readonly moverClearance?: (
    locationIds: readonly string[],
  ) => Promise<{ clear: boolean; repointLocationId?: string }>
}): AddonApi {
  const dhLeaf = (fn: (input: unknown) => unknown) => ({
    query: (input: unknown) => Promise.resolve(fn(input)),
    mutate: (input: unknown) => Promise.resolve(fn(input)),
  })
  const deviceHistory = deps.deviceHistory ?? {
    declareSeries: dhLeaf((input: unknown) => {
      const name =
        typeof input === 'object' &&
        input !== null &&
        'name' in input &&
        typeof input.name === 'string'
          ? input.name
          : undefined
      return {
        key: name ? `addon:pipeline-analytics/${name}` : 'addon:pipeline-analytics/test',
      }
    }),
    record: dhLeaf(() => ({ accepted: 0, refused: [] })),
    recordBuckets: dhLeaf(() => ({ accepted: 0, refused: [] })),
    query: dhLeaf(() => ({ resolution: '5m' as const, series: [], truncated: false })),
    queryNode: dhLeaf(() => ({ resolution: '5m' as const, series: [], truncated: false })),
    listSeries: dhLeaf(() => []),
    listNodeSeries: dhLeaf(() => []),
    getDeviceEnabled: dhLeaf(() => ({ enabled: true })),
    setDeviceEnabled: dhLeaf(() => ({ enabled: true })),
    getStatus: dhLeaf(() => ({
      startedAt: 0,
      ready: true,
      series: 0,
      metrics: 0,
      optedOutDevices: 0,
      tiers: [],
      capture: {
        eventsSeen: 0,
        pointsEmitted: 0,
        pointsWritten: 0,
        pointsDropped: 0,
        bufferDepth: 0,
        trailingEmitted: 0,
        reconciledPoints: 0,
        reconcileRuns: 0,
        reconcileFailures: 0,
        lastReconcileAt: null,
        lastFlushAt: null,
        flushFailures: 0,
        skipped: {},
      },
      ingest: { accepted: 0, refused: {} },
      rollup: {
        last5mAt: null,
        last1hAt: null,
        last1dAt: null,
        errors: 0,
        dirty5m: 0,
        dirty1h: 0,
        dirty1d: 0,
      },
      retention: { lastRunAt: null, deleted: {}, purgedSeries: 0 },
      directory: { devices: 0, lastRefreshAt: null },
    })),
  }
  return {
    settingsStore: deps.settingsStore,
    deviceManager: deps.deviceManager,
    deviceHistory,
    storageMigration: {
      moverClearance: {
        query: ({ locationIds }: { locationIds: readonly string[] }) =>
          deps.moverClearance?.(locationIds) ?? Promise.resolve({ clear: true }),
      },
    },
    ...(deps.pipelineExecutor !== undefined ? { pipelineExecutor: deps.pipelineExecutor } : {}),
    // ALWAYS present, like production. The provider is the sqlite-settings
    // BUILTIN — the same addon that serves `settingsStore` — so a hub with a
    // settings store and no vector store does not exist, and a fake that
    // omitted it made the face and identity galleries testable in a state the
    // real system cannot be in. Supply your own to inspect what was written.
    vectorStore: deps.vectorStore ?? makeFakeVectorStore().client,
    ...(deps.pipelineRunner !== undefined ? { pipelineRunner: deps.pipelineRunner } : {}),
    ...(deps.snapshot !== undefined ? { snapshot: deps.snapshot } : {}),
    ...(deps.integrations !== undefined ? { integrations: deps.integrations } : {}),
    ...(deps.notificationOutput !== undefined
      ? { notificationOutput: deps.notificationOutput }
      : {}),
  } as unknown as AddonApi
}

/** The `integrations` ports `DeclaredDevices` reaches for, as a test double. */
export interface FakeIntegrationsNamespace {
  readonly getByAddonId: { query: (input: { addonId: string }) => Promise<unknown> }
  readonly create: { mutate: (input: unknown) => Promise<unknown> }
  readonly update: { mutate: (input: unknown) => Promise<unknown> }
}

/**
 * An `integrations` namespace whose FIRST call never settles — the cold-boot
 * shape measured on the live hub, where the child forks before `$core-caps`
 * exists and the read sits in the 60 s UDS timeout at every boot.
 */
export function makeHangingIntegrations(): FakeIntegrationsNamespace {
  const never = (): Promise<never> => new Promise<never>(() => {})
  return {
    getByAddonId: { query: never },
    create: { mutate: never },
    update: { mutate: never },
  }
}

/** What the gate's re-detection reads back: the executor's `FrameResult` slice. */
export interface FakeRedetectResult {
  readonly width: number
  readonly height: number
  readonly detections: ReadonlyArray<{
    readonly macroClass: string
    readonly score: number
    readonly bbox: {
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
  }>
}

/**
 * The root identity a live frame is stamped with — the session detector the
 * confirmation gate re-judges a birth with (D925). An e2e frame that should
 * reach the gate's re-detect carries it, as every executor-produced frame does.
 */
export const FAKE_SESSION_ROOT = {
  rootStepId: 'object-detection',
  rootModelId: 'yolov9m-320',
  rootDeviceKey: 'openvino:gpu',
} as const

/** What a fake executor answers: the injected slice plus the stamps of what RAN. */
export interface FakeRedetectAnswer extends FakeRedetectResult {
  readonly discarded?: ReadonlyArray<{
    readonly macroClass: string
    readonly score: number
    readonly reason: string
  }>
  readonly rootModelId?: string
  readonly rootDeviceKey?: string
}

/**
 * A `pipelineExecutor` whose `runPipeline` answers every crop with the same
 * injected result, stamped — like the real executor — with the model and pool
 * it was asked to run (D925).
 */
export interface FakePipelineExecutor {
  readonly runPipeline: { mutate: (input: unknown, opts?: unknown) => Promise<FakeRedetectAnswer> }
}

/** The model and pool a re-detect request names, as the real executor stamps them. */
function stampsOf(input: unknown): { rootModelId?: string; rootDeviceKey?: string } {
  if (typeof input !== 'object' || input === null) return {}
  const steps: unknown = Reflect.get(input, 'steps')
  const first: unknown = Array.isArray(steps) ? steps[0] : undefined
  const modelId: unknown =
    typeof first === 'object' && first !== null ? Reflect.get(first, 'modelId') : undefined
  const deviceKey: unknown = Reflect.get(input, 'deviceKey')
  return {
    ...(typeof modelId === 'string' ? { rootModelId: modelId } : {}),
    ...(typeof deviceKey === 'string' ? { rootDeviceKey: deviceKey } : {}),
  }
}

export function makeFakePipelineExecutor(respond: (input: unknown) => FakeRedetectResult): {
  executor: FakePipelineExecutor
  calls: unknown[]
} {
  const calls: unknown[] = []
  return {
    calls,
    executor: {
      runPipeline: {
        mutate: async (input: unknown) => {
          calls.push(input)
          return { ...respond(input), ...stampsOf(input) }
        },
      },
    },
  }
}

/** One `pipelineRunner.getNativeCrop` request, as the transport issues it. */
export interface FakeNativeCropRequest {
  readonly handle: { readonly nodeId: string; readonly shmId: string }
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly maxWidth?: number
}

/** What a runner replies with (see `NativeCropReply` in the transport). */
export interface FakeNativeCropReply {
  readonly jpeg?: string
  readonly bytes?: readonly number[]
  readonly width: number
  readonly height: number
  readonly tier?: 'native' | 'ram-fullframe'
}

/** One `pipelineRunner.parkTrackFrame` order, as the parked-frame client sends it (D422). */
export interface FakeParkRequest {
  readonly deviceId: number
  readonly trackId: string
  readonly kind: 'keyFrame' | 'thumbnail'
  readonly handle: { readonly nodeId: string; readonly shmId: string }
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly maxWidth?: number
  readonly timestamp: number
}

/** What the fake node answers a park with. `refused` mirrors the runner's own refusal shape. */
export type FakeParkReply =
  | { readonly kind: 'parked' }
  | {
      readonly kind: 'refused'
      readonly reason: 'handle-gone' | 'encode-failed'
      readonly handleAgeMs: number | null
    }

/** One `pipelineRunner.getParkedTrackFrame` read — a retrieval keyed by track. */
export interface FakeParcelRead {
  readonly deviceId: number
  readonly trackId: string
  readonly kind: 'keyFrame' | 'thumbnail'
}

export interface FakePipelineRunner {
  readonly getNativeCrop: {
    query: (input: unknown, opts?: unknown) => Promise<FakeNativeCropReply | null>
  }
  readonly parkTrackFrame: {
    mutate: (input: unknown, opts?: unknown) => Promise<unknown>
  }
  readonly getParkedTrackFrame: {
    query: (input: unknown, opts?: unknown) => Promise<unknown>
  }
  readonly releaseParkedTrackFrames: {
    mutate: (input: unknown, opts?: unknown) => Promise<{ released: number }>
  }
}

export interface FakePipelineRunnerOptions {
  /** How the node answers a PARK. Default: parked, and the parcel is served. */
  readonly park?: (request: FakeParkRequest) => Promise<FakeParkReply>
  /** Whether a parcel the node parked is still there at retrieval. Default: held. */
  readonly parcelRead?: (read: FakeParcelRead) => Promise<'held' | 'gone'>
}

/** A real, small JPEG — the parcel must survive sharp on the hub side
 *  (`deriveKeyFrameSmall`, the thumbnail compose). Built once. */
let fakeParcelJpegBase64: string | null = null
async function fakeParcelJpeg(): Promise<string> {
  if (fakeParcelJpegBase64 === null) {
    const jpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 90, b: 200 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer()
    fakeParcelJpegBase64 = jpeg.toString('base64')
  }
  return fakeParcelJpegBase64
}

function parcelKey(read: FakeParcelRead): string {
  return `${read.deviceId} ${read.trackId} ${read.kind}`
}

/**
 * A `pipelineRunner` whose `getNativeCrop` records every request and answers
 * from an injected responder. FULL-FRAME requests (`bbox {0,0,1,1}`) are the
 * key-frame path; everything else is a subject crop.
 *
 * Since D422 it also serves the PARK methods: every order is recorded in
 * `parks`, answered by `options.park` (default: parked), and a parked parcel
 * is served back by `(deviceId, trackId, kind)` — every read recorded in
 * `parcelReads` — until released or until `options.parcelRead` says `gone`.
 */
export function makeFakePipelineRunner(
  respond: (request: FakeNativeCropRequest) => Promise<FakeNativeCropReply | null>,
  options: FakePipelineRunnerOptions = {},
): {
  runner: FakePipelineRunner
  requests: FakeNativeCropRequest[]
  parks: FakeParkRequest[]
  parcelReads: FakeParcelRead[]
} {
  const requests: FakeNativeCropRequest[] = []
  const parks: FakeParkRequest[] = []
  const parcelReads: FakeParcelRead[] = []
  const parcels = new Map<string, { timestamp: number; parkedAt: number }>()
  const readIdentity = (input: unknown): FakeParcelRead | null => {
    if (typeof input !== 'object' || input === null) return null
    if (!('deviceId' in input) || !('trackId' in input) || !('kind' in input)) return null
    const kind = input.kind === 'thumbnail' ? 'thumbnail' : 'keyFrame'
    return { deviceId: Number(input.deviceId), trackId: String(input.trackId), kind }
  }
  return {
    requests,
    parks,
    parcelReads,
    runner: {
      parkTrackFrame: {
        mutate: async (input: unknown) => {
          const identity = readIdentity(input)
          if (identity === null || typeof input !== 'object' || input === null) {
            return { parked: false, nodeId: 'fake', reason: 'handle-gone', handleAgeMs: null }
          }
          if (!('handle' in input) || !('bbox' in input) || !('timestamp' in input)) {
            return { parked: false, nodeId: 'fake', reason: 'handle-gone', handleAgeMs: null }
          }
          const { handle, bbox } = input
          if (typeof handle !== 'object' || handle === null) {
            return { parked: false, nodeId: 'fake', reason: 'handle-gone', handleAgeMs: null }
          }
          if (typeof bbox !== 'object' || bbox === null) {
            return { parked: false, nodeId: 'fake', reason: 'handle-gone', handleAgeMs: null }
          }
          if (!('nodeId' in handle) || !('shmId' in handle)) {
            return { parked: false, nodeId: 'fake', reason: 'handle-gone', handleAgeMs: null }
          }
          if (!('x' in bbox) || !('y' in bbox) || !('w' in bbox) || !('h' in bbox)) {
            return { parked: false, nodeId: 'fake', reason: 'handle-gone', handleAgeMs: null }
          }
          const request: FakeParkRequest = {
            ...identity,
            handle: { nodeId: String(handle.nodeId), shmId: String(handle.shmId) },
            bbox: { x: Number(bbox.x), y: Number(bbox.y), w: Number(bbox.w), h: Number(bbox.h) },
            ...('maxWidth' in input && typeof input.maxWidth === 'number'
              ? { maxWidth: input.maxWidth }
              : {}),
            timestamp: Number(input.timestamp),
          }
          parks.push(request)
          const reply = await (options.park?.(request) ?? Promise.resolve({ kind: 'parked' }))
          if (reply.kind === 'refused') {
            return {
              parked: false,
              nodeId: request.handle.nodeId,
              reason: reply.reason,
              handleAgeMs: reply.handleAgeMs,
            }
          }
          const replaced = parcels.has(parcelKey(identity))
          parcels.set(parcelKey(identity), { timestamp: request.timestamp, parkedAt: Date.now() })
          return {
            parked: true,
            nodeId: request.handle.nodeId,
            width: 64,
            height: 48,
            bytes: 1_024,
            replaced,
          }
        },
      },
      getParkedTrackFrame: {
        query: async (input: unknown) => {
          const identity = readIdentity(input)
          if (identity === null) return null
          parcelReads.push(identity)
          const parcel = parcels.get(parcelKey(identity))
          if (parcel === undefined) return null
          const verdict = await (options.parcelRead?.(identity) ?? Promise.resolve('held'))
          if (verdict === 'gone') return null
          return {
            jpeg: await fakeParcelJpeg(),
            width: 64,
            height: 48,
            timestamp: parcel.timestamp,
            parkedAt: parcel.parkedAt,
          }
        },
      },
      releaseParkedTrackFrames: {
        mutate: async (input: unknown) => {
          if (typeof input !== 'object' || input === null) return { released: 0 }
          if (!('deviceId' in input) || !('trackId' in input)) return { released: 0 }
          let released = 0
          for (const kind of ['keyFrame', 'thumbnail'] as const) {
            const key = parcelKey({
              deviceId: Number(input.deviceId),
              trackId: String(input.trackId),
              kind,
            })
            if (parcels.delete(key)) released += 1
          }
          return { released }
        },
      },
      getNativeCrop: {
        query: async (input: unknown) => {
          if (typeof input !== 'object' || input === null) return null
          if (!('handle' in input) || !('bbox' in input)) return null
          const { handle, bbox } = input
          if (typeof handle !== 'object' || handle === null) return null
          if (typeof bbox !== 'object' || bbox === null) return null
          if (!('nodeId' in handle) || !('shmId' in handle)) return null
          if (!('x' in bbox) || !('y' in bbox) || !('w' in bbox) || !('h' in bbox)) return null
          const request: FakeNativeCropRequest = {
            handle: { nodeId: String(handle.nodeId), shmId: String(handle.shmId) },
            bbox: { x: Number(bbox.x), y: Number(bbox.y), w: Number(bbox.w), h: Number(bbox.h) },
            ...('maxWidth' in input && typeof input.maxWidth === 'number'
              ? { maxWidth: input.maxWidth }
              : {}),
          }
          requests.push(request)
          return respond(request)
        },
      },
    },
  }
}

/** True for a FULL-FRAME request (bbox {0,0,1,1}) at ANY width. Three
 *  different consumers issue one — the key frame at 4096, the boxed timeline
 *  tile at 960 and the display-crop fallback at 1920 — so this alone does NOT
 *  identify a key-frame capture; use {@link isKeyFrameRequest}. */
export function isFullFrameRequest(request: FakeNativeCropRequest): boolean {
  const { x, y, w, h } = request.bbox
  return x === 0 && y === 0 && w === 1 && h === 1
}

/** The `keyFrame` capture specifically: a full frame at the NATIVE width cap. */
export function isKeyFrameRequest(request: FakeNativeCropRequest): boolean {
  return isFullFrameRequest(request) && request.maxWidth === KEYFRAME_NATIVE_MAX_WIDTH
}

/** A PARK of the track's key frame (D422): the whole frame at the native cap. */
export function isKeyFramePark(park: FakeParkRequest): boolean {
  return park.kind === 'keyFrame' && park.maxWidth === KEYFRAME_NATIVE_MAX_WIDTH
}

/**
 * In-memory `vector-store` client for tests.
 *
 * Behaves like the real provider in the two ways that matter to callers: it
 * REFUSES an upsert into an index that was never declared, and its `query`
 * actually applies the prefilter. A permissive fake would let a caller that
 * forgot to declare, or that built a filter wrongly, pass the suite — which is
 * the failure mode this repo has shipped twice.
 *
 * Ranking is a plain cosine so a test can assert an ordering, but the scores
 * are not the point; the point is the plumbing around them.
 */
/**
 * A throwaway `EmbeddingVectorIndex` over a fresh in-memory vector store.
 *
 * Both gallery stores REQUIRE one — production always has the sqlite-settings
 * builtin behind it — so a spec that constructs a `FaceStore` or an
 * `IdentityStore` gets a real index rather than a stub that silently accepts
 * everything. Returned alongside its client so a spec can read back exactly
 * what was indexed.
 */
export function makeFakeEmbeddingIndex(index: string): {
  vectors: EmbeddingVectorIndex
  client: ReturnType<typeof makeFakeVectorStore>['client']
  rows: ReturnType<typeof makeFakeVectorStore>['rows']
} {
  const fake = makeFakeVectorStore()
  return {
    vectors: new EmbeddingVectorIndex({
      index,
      client: fake.client,
      logger: makeSilentLogger(),
    }),
    client: fake.client,
    rows: fake.rows,
  }
}

/**
 * The rows one index holds in a {@link makeFakeVectorStore}, for assertions.
 *
 * A helper rather than reaching into the `rows` map inline, so a spec that
 * looks up the wrong index name gets an empty map from ONE place — and so the
 * shape of the internal map is not copied into a dozen specs.
 */
export function vectorRows(
  fake: ReturnType<typeof makeFakeVectorStore>,
  index: string,
): ReadonlyMap<string, { vector: string; metadata: VectorMetadata }> {
  return fake.rows.get(index) ?? new Map()
}

export interface FakeVectorStoreOptions {
  /**
   * The backend's KNN ceiling, mirroring sqlite-vec's `VEC_KNN_MAX_K`.
   *
   * Present so a spec can reproduce the real failure: a caller asking for
   * 20,000 got 4,096 and was told only by a log line in another process.
   * Omitted = no ceiling.
   */
  readonly maxTopK?: number
}

export function makeFakeVectorStore(options: FakeVectorStoreOptions = {}) {
  const indexes = new Map<string, number>()
  const rows = new Map<string, Map<string, { vector: string; metadata: VectorMetadata }>>()

  const rowsOf = (index: string): Map<string, { vector: string; metadata: VectorMetadata }> => {
    const existing = rows.get(index)
    if (existing !== undefined) return existing
    const fresh = new Map<string, { vector: string; metadata: VectorMetadata }>()
    rows.set(index, fresh)
    return fresh
  }

  const requireIndex = (index: string): void => {
    if (!indexes.has(index)) throw new Error(`vector-store: index "${index}" was never declared`)
  }

  const passes = (metadata: VectorMetadata, filter?: VectorFilter): boolean => {
    if (filter === undefined) return true
    for (const [key, expected] of Object.entries(filter.equals ?? {})) {
      if (metadata[key] !== expected) return false
    }
    for (const [key, [lo, hi]] of Object.entries(filter.between ?? {})) {
      const actual = metadata[key]
      if (typeof actual !== 'number' || actual < lo || actual > hi) return false
    }
    return true
  }

  const client = {
    declareIndex: {
      mutate: async (input: { index: string; dim: number }) => {
        const existing = indexes.get(input.index)
        if (existing !== undefined && existing !== input.dim) {
          throw vectorIndexDimConflictError(input.index, existing, input.dim)
        }
        indexes.set(input.index, input.dim)
        rowsOf(input.index)
      },
    },
    upsert: {
      mutate: async (input: {
        index: string
        items: Array<{ id: string; vector: string; metadata: VectorMetadata }>
      }) => {
        requireIndex(input.index)
        const dim = indexes.get(input.index)
        const target = rowsOf(input.index)
        let upserted = 0
        let rejected = 0
        for (const item of input.items) {
          if (dim !== undefined && vectorDimFromBase64(item.vector) !== dim) {
            rejected += 1
            continue
          }
          target.set(item.id, { vector: item.vector, metadata: item.metadata })
          upserted += 1
        }
        return { upserted, rejected }
      },
    },
    query: {
      query: async (input: {
        index: string
        vector: string
        topK: number
        minScore?: number
        filter?: VectorFilter
      }) => {
        requireIndex(input.index)
        const queryVec = decodeVectorBase64(input.vector)
        const admitted = [...rowsOf(input.index).entries()].filter(([, r]) =>
          passes(r.metadata, input.filter),
        )
        const scored = admitted
          .map(([id, r]) => ({
            id,
            score: cosineSimilarity(queryVec, decodeVectorBase64(r.vector)),
            metadata: r.metadata,
          }))
          .filter((m) => m.score >= (input.minScore ?? Number.NEGATIVE_INFINITY))
          .sort((a, b) => b.score - a.score)
        // The CEILING, applied exactly where the real backend applies it.
        const k = Math.min(input.topK, options.maxTopK ?? input.topK)
        return {
          matches: scored.slice(0, k),
          scanned: admitted.length,
          truncated: k < input.topK && scored.length >= k,
          effectiveTopK: k,
        }
      },
    },
    fetchByIds: {
      query: async (input: { index: string; ids: string[] }) => {
        requireIndex(input.index)
        const target = rowsOf(input.index)
        const items: Array<{ id: string; vector: string; metadata: VectorMetadata }> = []
        for (const id of input.ids) {
          const row = target.get(id)
          if (row !== undefined) items.push({ id, vector: row.vector, metadata: row.metadata })
        }
        return { items }
      },
    },
    scan: {
      query: async (input: { index: string; cursor: number; limit: number }) => {
        requireIndex(input.index)
        // Ordered by id and NOT subject to the KNN ceiling — the whole point of
        // the method. A fake that paged in insertion order would let a cursor
        // bug pass, so it sorts the way the backend's `ORDER BY id` does.
        const all = [...rowsOf(input.index).entries()].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )
        const page = all.slice(input.cursor, input.cursor + input.limit)
        const items = page.map(([id, row]) => ({ id, metadata: row.metadata }))
        return {
          items,
          nextCursor: input.cursor + page.length >= all.length ? null : input.cursor + page.length,
        }
      },
    },
    getByIds: {
      query: async (input: { index: string; ids: string[] }) => {
        requireIndex(input.index)
        const target = rowsOf(input.index)
        const items: Array<{ id: string; metadata: VectorMetadata }> = []
        for (const id of input.ids) {
          const row = target.get(id)
          if (row !== undefined) items.push({ id, metadata: row.metadata })
        }
        return { items }
      },
    },
    deleteByIds: {
      mutate: async (input: { index: string; ids: string[] }) => {
        requireIndex(input.index)
        const target = rowsOf(input.index)
        let deleted = 0
        for (const id of input.ids) {
          if (target.delete(id)) deleted += 1
        }
        return { deleted }
      },
    },
    deleteByFilter: {
      mutate: async (input: { index: string; filter: VectorFilter }) => {
        requireIndex(input.index)
        const target = rowsOf(input.index)
        let deleted = 0
        for (const [id, row] of [...target.entries()]) {
          if (passes(row.metadata, input.filter)) {
            target.delete(id)
            deleted += 1
          }
        }
        return { deleted }
      },
    },
  }

  return { client, indexes, rows }
}
