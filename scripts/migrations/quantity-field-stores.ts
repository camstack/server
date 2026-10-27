/**
 * The stores the quantity-field migration reads and rewrites, one planner per
 * store. A planner reads its tables (never writes), tallies every reference it
 * would change, and hands back an `apply` closure that performs the writes
 * inside the caller's transaction. The tally of a second planning pass over the
 * rewritten file is what the orchestrator verifies against.
 *
 * Which tables, and how each was found:
 *
 *  settings file `camstack.db` (`sqlite-storage/sqlite-settings-backend.ts`)
 *   - `device-runtime-state`   one row per device, `data` = the whole cap-slice
 *                              map plus `$owned` claims (D663).
 *   - `addon-device-settings`  one row per (addon, device, key); OSD bindings,
 *                              exporter and provider per-device settings.
 *   - `addon-settings`         one row per (addon, key); OSD named templates.
 *   - `system-settings`        section rows.
 *   - `records` (+ `_record_kinds`)  every kind: core blocks (compositions,
 *                              customizations, helpers, recipes), notification
 *                              rules, user preferences.
 *  history file `history.db` (`device-history/store/history-schema.ts`)
 *   - `device-history:metrics` / `series`  the key `cap:<cap>.<field>`;
 *     `raw` and the three rollup tiers hang off `series.id` and move with it.
 */
import type Database from 'better-sqlite3'
import {
  HISTORY_KEY_PREFIX,
  isNewFieldName,
  parseHistoryKey,
  relocatedHistoryKey,
  renamedHistoryKey,
  splitFieldPath,
  trackedFieldTokens,
} from './quantity-field-renames.ts'
import {
  bump,
  newSink,
  refKey,
  type RewriteSink,
  rewriteRuntimeBlob,
  type Tally,
  walk,
} from './quantity-field-rewrite.ts'

export type Db = Database.Database

/** What one store holds, and what a rewrite would do to it. */
export interface StorePlan {
  readonly store: string
  readonly rowsScanned: number
  readonly rowsToChange: number
  readonly seen: Tally
  readonly merged: Tally
  readonly advisories: Tally
  readonly rewrites: Tally
  readonly dropped: Tally
  readonly moved: Tally
}

export interface FilePlan {
  readonly stores: readonly StorePlan[]
  /** Performs the writes. Call it inside ONE transaction. */
  readonly apply: () => void
  /** True when `apply` would change the file. */
  readonly hasWork: boolean
}

interface Accumulator {
  readonly store: string
  readonly sink: RewriteSink
  rowsScanned: number
  rowsToChange: number
}

function accumulate(table: Map<string, Accumulator>, store: string): Accumulator {
  const existing = table.get(store)
  if (existing !== undefined) return existing
  const created: Accumulator = {
    store,
    sink: newSink(),
    rowsScanned: 0,
    rowsToChange: 0,
  }
  table.set(store, created)
  return created
}

function toPlans(table: ReadonlyMap<string, Accumulator>): StorePlan[] {
  return [...table.values()]
    .toSorted((a, b) => a.store.localeCompare(b.store))
    .map((acc) => ({
      store: acc.store,
      rowsScanned: acc.rowsScanned,
      rowsToChange: acc.rowsToChange,
      seen: acc.sink.seen,
      merged: acc.sink.merged,
      advisories: acc.sink.advisories,
      rewrites: acc.sink.rewrites,
      dropped: acc.sink.dropped,
      moved: acc.sink.moved,
    }))
}

function hasTable(db: Db, name: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name)
  return row !== undefined
}

const TOKENS: readonly string[] = trackedFieldTokens()

/** A stored text can only hold a tracked reference when it names a tracked name. */
function mentionsTrackedField(text: string): boolean {
  return TOKENS.some((token) => text.includes(token))
}

type Rewrite = (parsed: unknown, sink: RewriteSink) => unknown

interface PendingWrite {
  readonly run: () => void
}

interface KeyValueRow {
  readonly id: string
  readonly data: string
}

function planKeyValueTable(
  db: Db,
  table: string,
  rewrite: Rewrite,
  accs: Map<string, Accumulator>,
  writes: PendingWrite[],
): void {
  const update = db.prepare<[string, string]>(`UPDATE "${table}" SET data = ? WHERE id = ?`)
  const acc = accumulate(accs, table)
  const iterator = db.prepare<[], KeyValueRow>(`SELECT id, data FROM "${table}"`).iterate()
  for (const row of iterator) {
    acc.rowsScanned += 1
    if (!mentionsTrackedField(row.data)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(row.data)
    } catch {
      continue
    }
    const next = rewrite(parsed, acc.sink)
    if (next === parsed) continue
    acc.rowsToChange += 1
    const text = JSON.stringify(next)
    writes.push({ run: () => void update.run(text, row.id) })
  }
}

/** The canonical key/value collections, and the per-addon tables `<addonId>:<base>` mirroring them. */
const RUNTIME_STATE_BASE = 'device-runtime-state'
const KEY_VALUE_BASES: readonly string[] = [
  'system-settings',
  'addon-settings',
  'addon-device-settings',
  'addon-devices',
  'sections',
  RUNTIME_STATE_BASE,
]

interface TableName {
  readonly name: string
}

function keyValueTables(db: Db): readonly { readonly table: string; readonly base: string }[] {
  return db
    .prepare<[], TableName>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .flatMap((row) => {
      const base = KEY_VALUE_BASES.find((b) => row.name === b || row.name.endsWith(`:${b}`))
      return base === undefined ? [] : [{ table: row.name, base }]
    })
    .filter(({ table }) => hasKeyValueShape(db, table))
}

/** `(id, data)` tables only: a same-named table of another shape is left alone. */
function hasKeyValueShape(db: Db, table: string): boolean {
  const columns = db
    .prepare<[], ColumnInfo>(`PRAGMA table_info("${table}")`)
    .all()
    .map((c) => c.name)
  return columns.includes('id') && columns.includes('data')
}

interface RecordRow {
  readonly rid: number
  readonly owner: string
  readonly kind: string
  readonly json: string
}

function planRecords(db: Db, accs: Map<string, Accumulator>, writes: PendingWrite[]): void {
  if (!hasTable(db, 'records') || !hasTable(db, '_record_kinds')) return
  const update = db.prepare<[string, number]>('UPDATE records SET data = jsonb(?) WHERE rid = ?')
  const iterator = db
    .prepare<[], RecordRow>(
      'SELECT r.rid AS rid, k.owner AS owner, k.kind AS kind, json(r.data) AS json ' +
        'FROM records r JOIN _record_kinds k ON k.kind_id = r.kind_id',
    )
    .iterate()
  for (const row of iterator) {
    const acc = accumulate(accs, `records[${row.owner}/${row.kind}]`)
    acc.rowsScanned += 1
    if (!mentionsTrackedField(row.json)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(row.json)
    } catch {
      continue
    }
    const next = walk(parsed, acc.sink)
    if (next === parsed) continue
    acc.rowsToChange += 1
    const text = JSON.stringify(next)
    writes.push({ run: () => void update.run(text, row.rid) })
  }
}

/** The settings file: runtime state, the three settings tables, every record kind. */
export function planSettingsDb(db: Db): FilePlan {
  const accs = new Map<string, Accumulator>()
  const writes: PendingWrite[] = []
  for (const { table, base } of keyValueTables(db)) {
    planKeyValueTable(
      db,
      table,
      base === RUNTIME_STATE_BASE ? rewriteRuntimeBlob : walk,
      accs,
      writes,
    )
  }
  planRecords(db, accs, writes)
  return {
    stores: toPlans(accs),
    hasWork: writes.length > 0,
    apply: () => {
      for (const write of writes) write.run()
    },
  }
}

// ── history.db ────────────────────────────────────────────────────────────────

const METRICS = 'device-history:metrics'
const SERIES = 'device-history:series'
const POINT_TABLES: readonly {
  readonly table: string
  readonly orderBy: string
}[] = [
  { table: 'device-history:raw', orderBy: 'ts' },
  { table: 'device-history:rollup-5m', orderBy: 'bucket_start' },
  { table: 'device-history:rollup-1h', orderBy: 'bucket_start' },
  { table: 'device-history:rollup-1d', orderBy: 'bucket_start' },
]

interface SeriesRow {
  readonly id: number
  readonly key: string
  readonly subject: string
  readonly scope: string
  readonly first_ts: number
  readonly last_ts: number
}

interface MetricRow {
  readonly key: string
}

interface ColumnInfo {
  readonly name: string
}

/** `cap.field` of a history key whose field is one the map tracks, else null. */
function trackedKeyRef(key: string): string | null {
  const parts = parseHistoryKey(key)
  if (parts === null) return null
  const { field } = splitFieldPath(parts.path)
  if (
    renamedHistoryKey(key) === null &&
    !isNewFieldName(parts.cap, field) &&
    relocatedHistoryKey(key) === null
  )
    return null
  return refKey(parts.cap, field)
}

/** `cap.newField` of the key a renamed key becomes. */
function renamedKeyRef(newKey: string): string | null {
  const parts = parseHistoryKey(newKey)
  return parts === null ? null : refKey(parts.cap, splitFieldPath(parts.path).field)
}

function countRows(db: Db, table: string, keyColumn: string, id: number): number {
  const row = db
    .prepare<[number], { n: number }>(`SELECT count(*) AS n FROM "${table}" WHERE ${keyColumn} = ?`)
    .get(id)
  return row?.n ?? 0
}

function countConflicts(
  db: Db,
  table: string,
  orderBy: string,
  source: number,
  target: number,
): number {
  const row = db
    .prepare<[number, number], { n: number }>(
      `SELECT count(*) AS n FROM "${table}" a WHERE a.series_id = ? AND EXISTS ` +
        `(SELECT 1 FROM "${table}" b WHERE b.series_id = ? AND b.${orderBy} = a.${orderBy})`,
    )
    .get(source, target)
  return row?.n ?? 0
}

interface SeriesMove {
  readonly source: SeriesRow
  readonly newKey: string
  /** The series the points merge into; null for a plain re-key or a drop. */
  readonly targetId: number | null
  /** The series is deleted with its points (a re-homed field the device already has). */
  readonly drop: boolean
}

function identityOf(key: string, row: SeriesRow): string {
  return `${key}\u0000${row.subject}\u0000${row.scope}`
}

/** The identities that exist once every rename is applied, re-homed series excluded. */
function finalIdentities(rows: readonly SeriesRow[]): ReadonlySet<string> {
  return new Set(
    rows
      .filter((row) => relocatedHistoryKey(row.key) === null)
      .map((row) => identityOf(renamedHistoryKey(row.key) ?? row.key, row)),
  )
}

interface SeriesCounters {
  readonly series: Accumulator
  readonly points: readonly Accumulator[]
}

/** Tally `rows` of a re-homed series: points per store, the series itself once. */
function countRelocation(
  db: Db,
  row: SeriesRow,
  counters: SeriesCounters,
  tally: (sink: RewriteSink) => Tally,
  ref: string,
): void {
  bump(tally(counters.series.sink), ref)
  POINT_TABLES.forEach((t, index) => {
    const acc = counters.points[index]
    if (acc === undefined) return
    bump(tally(acc.sink), ref, countRows(db, t.table, 'series_id', row.id))
  })
}

function planSeries(db: Db, accs: Map<string, Accumulator>): readonly SeriesMove[] {
  const rows = db
    .prepare<[], SeriesRow>(
      `SELECT id, key, subject, scope, first_ts, last_ts FROM "${SERIES}" WHERE key LIKE '${HISTORY_KEY_PREFIX}%'`,
    )
    .all()
  const byIdentity = new Map(rows.map((row) => [identityOf(row.key, row), row]))
  const existing = finalIdentities(rows)
  const seriesAcc = accumulate(accs, SERIES)
  const pointAccs = POINT_TABLES.map((t) => accumulate(accs, t.table))
  const counters: SeriesCounters = { series: seriesAcc, points: pointAccs }
  const moves: SeriesMove[] = []
  seriesAcc.rowsScanned = rows.length
  for (const row of rows) {
    const ref = trackedKeyRef(row.key)
    if (ref === null) continue
    bump(seriesAcc.sink.seen, ref)
    POINT_TABLES.forEach((t, index) => {
      const acc = pointAccs[index]
      if (acc === undefined) return
      bump(acc.sink.seen, ref, countRows(db, t.table, 'series_id', row.id))
    })
    const home = relocatedHistoryKey(row.key)
    if (home !== null) {
      const homeRef = renamedKeyRef(home)
      if (homeRef === null) continue
      seriesAcc.rowsToChange += 1
      if (existing.has(identityOf(home, row))) {
        countRelocation(db, row, counters, (sink) => sink.dropped, ref)
        moves.push({ source: row, newKey: home, targetId: null, drop: true })
      } else {
        countRelocation(db, row, counters, (sink) => sink.moved, homeRef)
        moves.push({ source: row, newKey: home, targetId: null, drop: false })
      }
      continue
    }
    const newKey = renamedHistoryKey(row.key)
    if (newKey === null) continue
    const target = byIdentity.get(identityOf(newKey, row))
    const newRef = renamedKeyRef(newKey)
    if (newRef === null) continue
    seriesAcc.rowsToChange += 1
    if (target !== undefined) {
      bump(seriesAcc.sink.merged, newRef)
      POINT_TABLES.forEach((t, index) => {
        const acc = pointAccs[index]
        if (acc === undefined) return
        bump(acc.sink.merged, newRef, countConflicts(db, t.table, t.orderBy, row.id, target.id))
      })
    }
    moves.push({ source: row, newKey, targetId: target?.id ?? null, drop: false })
  }
  for (const acc of pointAccs) {
    acc.rowsScanned = rows.length
    acc.rowsToChange = moves.filter((m) => m.targetId !== null || m.drop).length
  }
  return moves
}

function pointColumns(db: Db, table: string): readonly string[] {
  return db
    .prepare<[], ColumnInfo>(`PRAGMA table_info("${table}")`)
    .all()
    .map((c) => c.name)
    .filter((name) => name !== 'series_id')
}

function applySeriesMoves(db: Db, moves: readonly SeriesMove[]): void {
  const rekey = db.prepare<[string, number]>(`UPDATE "${SERIES}" SET key = ? WHERE id = ?`)
  const widen = db.prepare<[number, number, number]>(
    `UPDATE "${SERIES}" SET first_ts = min(first_ts, ?), last_ts = max(last_ts, ?) WHERE id = ?`,
  )
  const dropSeries = db.prepare<[number]>(`DELETE FROM "${SERIES}" WHERE id = ?`)
  for (const move of moves) {
    if (move.drop) {
      for (const t of POINT_TABLES) {
        db.prepare<[number]>(`DELETE FROM "${t.table}" WHERE series_id = ?`).run(move.source.id)
      }
      dropSeries.run(move.source.id)
      continue
    }
    if (move.targetId === null) {
      rekey.run(move.newKey, move.source.id)
      continue
    }
    for (const t of POINT_TABLES) {
      const columns = pointColumns(db, t.table)
      const list = columns.map((c) => `"${c}"`).join(', ')
      db.prepare<[number, number]>(
        `INSERT OR IGNORE INTO "${t.table}" (series_id, ${list}) ` +
          `SELECT ?, ${list} FROM "${t.table}" WHERE series_id = ?`,
      ).run(move.targetId, move.source.id)
      db.prepare<[number]>(`DELETE FROM "${t.table}" WHERE series_id = ?`).run(move.source.id)
    }
    widen.run(move.source.first_ts, move.source.last_ts, move.targetId)
    dropSeries.run(move.source.id)
  }
}

function planMetrics(db: Db, accs: Map<string, Accumulator>): readonly (() => void)[] {
  const acc = accumulate(accs, METRICS)
  const rows = db
    .prepare<[], MetricRow>(`SELECT key FROM "${METRICS}" WHERE key LIKE '${HISTORY_KEY_PREFIX}%'`)
    .all()
  acc.rowsScanned = rows.length
  const keys = new Set(rows.map((row) => row.key))
  const finalKeys = new Set(
    rows
      .filter((row) => relocatedHistoryKey(row.key) === null)
      .map((row) => renamedHistoryKey(row.key) ?? row.key),
  )
  const rekey = db.prepare<[string, string]>(`UPDATE "${METRICS}" SET key = ? WHERE key = ?`)
  const drop = db.prepare<[string]>(`DELETE FROM "${METRICS}" WHERE key = ?`)
  const writes: (() => void)[] = []
  for (const row of rows) {
    const ref = trackedKeyRef(row.key)
    if (ref === null) continue
    bump(acc.sink.seen, ref)
    const home = relocatedHistoryKey(row.key)
    if (home !== null) {
      const homeRef = renamedKeyRef(home)
      acc.rowsToChange += 1
      if (finalKeys.has(home)) {
        bump(acc.sink.dropped, ref)
        writes.push(() => void drop.run(row.key))
      } else {
        if (homeRef !== null) bump(acc.sink.moved, homeRef)
        writes.push(() => void rekey.run(home, row.key))
      }
      continue
    }
    const newKey = renamedHistoryKey(row.key)
    if (newKey === null) continue
    const newRef = renamedKeyRef(newKey)
    if (newRef === null) continue
    acc.rowsToChange += 1
    if (keys.has(newKey)) {
      bump(acc.sink.merged, newRef)
      writes.push(() => void drop.run(row.key))
    } else {
      writes.push(() => void rekey.run(newKey, row.key))
    }
  }
  return writes
}

/** The history file: the metric catalog and the series, with every point and rollup kept. */
export function planHistoryDb(db: Db): FilePlan {
  const accs = new Map<string, Accumulator>()
  const complete =
    hasTable(db, METRICS) &&
    hasTable(db, SERIES) &&
    POINT_TABLES.every((t) => hasTable(db, t.table))
  if (!complete) return { stores: [], hasWork: false, apply: () => undefined }
  const metricWrites = planMetrics(db, accs)
  const moves = planSeries(db, accs)
  return {
    stores: toPlans(accs),
    hasWork: metricWrites.length > 0 || moves.length > 0,
    apply: () => {
      for (const write of metricWrites) write()
      applySeriesMoves(db, moves)
    },
  }
}
