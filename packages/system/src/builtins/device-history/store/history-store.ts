/**
 * Every read and write device-history makes against its tables, through the
 * settings door (D44). No addon-side code builds SQL; the shapes below are what
 * the engine prepares, and a spec asserts the plan of each on the REAL
 * statement (D447): every range is a PRIMARY KEY search on `(series_id, ts)` or
 * `(series_id, bucket_start)`, so no `ts` index exists or is needed.
 *
 * Every read states a `limit` — the door's default row bound is 2 000 and an
 * unstated one would silently truncate (D58's cousin).
 */
import type { DeviceHistoryKind } from '@camstack/types'
import type { RawPoint, RollupRow } from '../rollup/rollup-math.js'
import { rollupIsLegacy, scaledMagnitude } from './series-scale.js'
import type { RollupTier } from '../time/bucket-time.js'
import {
  COLLECTIONS,
  HISTORY_DECLARATIONS,
  HISTORY_NAMESPACE,
  rollupCollectionOf,
} from './history-schema.js'
import type { HistoryDoor } from './history-door.js'
import {
  type RowData,
  readNumber,
  readNumberOrNull,
  readText,
  readTextOrNull,
} from './row-readers.js'

export interface MetricRecord {
  readonly key: string
  readonly source: 'cap' | 'addon'
  readonly ownerAddon: string
  readonly subjectKind: 'device' | 'node'
  readonly kind: DeviceHistoryKind
  readonly unit: string | null
  readonly displayName: string
  readonly ingest: 'points' | 'buckets'
  readonly declaredAt: number
  /** `enum`: the value of each ordinal (index = ordinal), append-only; `null` for every other kind. */
  readonly values: readonly string[] | null
}

export interface SeriesRecord {
  readonly id: number
  readonly key: string
  /** `d:<deviceId>` | `n:<nodeId>`. */
  readonly subject: string
  readonly deviceId: number | null
  readonly scope: string
  readonly firstTs: number
  readonly lastTs: number
}

export interface NewSeries {
  readonly key: string
  readonly subject: string
  readonly deviceId: number | null
  readonly scope: string
  readonly ts: number
}

export interface SeriesSpanUpdate {
  readonly id: number
  readonly lastTs: number
}

export type StoredTier = 'raw' | RollupTier

/** Rows per `upsertMany` call: bounds one transaction on the history thread. */
const WRITE_CHUNK = 1_000
/** Operations per `transact`. */
const TRANSACT_CHUNK = 200
/** Rows per read page. */
export const READ_PAGE = 5_000

function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function parseKind(value: string): DeviceHistoryKind {
  if (value === 'gauge' || value === 'counter' || value === 'boolean' || value === 'enum') {
    return value
  }
  throw new Error(`history row: unknown kind "${value}"`)
}

/** A JSON TEXT column: the engine hands back the decoded value, or the text itself. */
function jsonColumn(data: RowData, column: string): unknown {
  const raw = data[column]
  if (raw === null || raw === undefined) return null
  return typeof raw === 'string' ? JSON.parse(raw) : raw
}

/** A JSON column that must hold a string array, or nothing. */
function parseValues(data: RowData): readonly string[] | null {
  const parsed = jsonColumn(data, 'enum_values')
  if (parsed === null) return null
  if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === 'string')) {
    return parsed
  }
  throw new Error('history row: column "enum_values" is not a JSON string array')
}

/** A JSON column that must hold `{ "<ordinal>": ms }`, or nothing. */
function parseStates(data: RowData): Readonly<Record<string, number>> | null {
  const parsed = jsonColumn(data, 'state_ms')
  if (parsed === null) return null
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('history row: column "state_ms" is not a JSON object')
  }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error('history row: column "state_ms" holds a non-number')
    }
    out[k] = v
  }
  return out
}

function parseMetric(data: RowData): MetricRecord {
  const source = readText(data, 'source')
  const subjectKind = readText(data, 'subject_kind')
  const ingest = readText(data, 'ingest')
  if (source !== 'cap' && source !== 'addon')
    throw new Error(`history row: unknown source "${source}"`)
  if (subjectKind !== 'device' && subjectKind !== 'node') {
    throw new Error(`history row: unknown subject_kind "${subjectKind}"`)
  }
  if (ingest !== 'points' && ingest !== 'buckets') {
    throw new Error(`history row: unknown ingest "${ingest}"`)
  }
  return {
    key: readText(data, 'key'),
    source,
    ownerAddon: readText(data, 'owner_addon'),
    subjectKind,
    kind: parseKind(readText(data, 'kind')),
    unit: readTextOrNull(data, 'unit'),
    displayName: readText(data, 'display_name'),
    ingest,
    declaredAt: readNumber(data, 'declared_at'),
    values: parseValues(data),
  }
}

function parseSeries(data: RowData): SeriesRecord {
  return {
    id: readNumber(data, 'id'),
    key: readText(data, 'key'),
    subject: readText(data, 'subject'),
    deviceId: readNumberOrNull(data, 'device_id'),
    scope: readText(data, 'scope'),
    firstTs: readNumber(data, 'first_ts'),
    lastTs: readNumber(data, 'last_ts'),
  }
}

function parseRollup(data: RowData): RollupRow {
  return {
    seriesId: readNumber(data, 'series_id'),
    bucketStart: readNumber(data, 'bucket_start'),
    samples: readNumber(data, 'samples'),
    sum: readNumber(data, 'sum'),
    min: readNumber(data, 'min'),
    max: readNumber(data, 'max'),
    last: readNumberOrNull(data, 'last'),
    lastTs: readNumberOrNull(data, 'last_ts'),
    twSum: readNumberOrNull(data, 'tw_sum'),
    twMs: readNumberOrNull(data, 'tw_ms'),
    states: parseStates(data),
  }
}

function rollupData(row: RollupRow): Record<string, unknown> {
  return {
    series_id: row.seriesId,
    bucket_start: row.bucketStart,
    samples: row.samples,
    sum: row.sum,
    min: row.min,
    max: row.max,
    last: row.last,
    last_ts: row.lastTs,
    tw_sum: row.twSum,
    tw_ms: row.twMs,
    state_ms: row.states === null ? null : JSON.stringify(row.states),
  }
}

function collectionOf(tier: StoredTier): string {
  return tier === 'raw' ? COLLECTIONS.raw : rollupCollectionOf(tier)
}

function orderColumnOf(tier: StoredTier): string {
  return tier === 'raw' ? 'ts' : 'bucket_start'
}

export class HistoryStore {
  constructor(private readonly door: HistoryDoor) {}

  async declare(): Promise<void> {
    for (const declaration of HISTORY_DECLARATIONS) {
      await this.door.declareCollection.mutate(declaration)
    }
  }

  // ── metrics ────────────────────────────────────────────────────────

  async loadMetrics(): Promise<readonly MetricRecord[]> {
    const rows = await this.door.query.query({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.metrics,
      filter: { limit: 20_000 },
    })
    return rows.map((r) => parseMetric(r.data))
  }

  /**
   * Delete metric rows no lookup can reach: rows an earlier build wrote under an
   * engine-minted random key (every metric key is `cap:` / `addon:` prefixed).
   */
  async deleteMetrics(keys: readonly string[]): Promise<void> {
    for (const batch of chunks(keys, WRITE_CHUNK)) {
      await this.door.deleteWhere.mutate({
        namespace: HISTORY_NAMESPACE,
        collection: COLLECTIONS.metrics,
        filter: { whereIn: { key: [...batch] } },
      })
    }
  }

  async upsertMetric(metric: MetricRecord): Promise<void> {
    await this.door.upsertMany.mutate({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.metrics,
      conflict: ['key'],
      records: [
        {
          // `key` is the PRIMARY KEY: the engine takes it from `id` and would mint a
          // random one without it — every boot then inserted a fresh, unreachable row.
          id: metric.key,
          data: {
            key: metric.key,
            source: metric.source,
            owner_addon: metric.ownerAddon,
            subject_kind: metric.subjectKind,
            kind: metric.kind,
            unit: metric.unit,
            display_name: metric.displayName,
            ingest: metric.ingest,
            declared_at: metric.declaredAt,
            enum_values: metric.values === null ? null : JSON.stringify(metric.values),
          },
        },
      ],
    })
  }

  // ── series ─────────────────────────────────────────────────────────

  /** Series with `id > afterId`, ascending — the boot load pages with this. */
  async loadSeriesPage(afterId: number, limit: number): Promise<readonly SeriesRecord[]> {
    const rows = await this.door.query.query({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.series,
      filter: {
        whereBetween: { id: [afterId + 1, Number.MAX_SAFE_INTEGER] },
        orderBy: { field: 'id', direction: 'asc' },
        limit,
      },
    })
    return rows.map((r) => parseSeries(r.data))
  }

  async findSeries(key: string, subject: string, scope: string): Promise<SeriesRecord | null> {
    const rows = await this.door.query.query({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.series,
      filter: { where: { key, subject, scope }, limit: 1 },
    })
    const first = rows[0]
    return first === undefined ? null : parseSeries(first.data)
  }

  async insertSeries(series: NewSeries): Promise<SeriesRecord> {
    const { id } = await this.door.insert.mutate({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.series,
      record: {
        data: {
          key: series.key,
          subject: series.subject,
          device_id: series.deviceId,
          scope: series.scope,
          first_ts: series.ts,
          last_ts: series.ts,
        },
      },
    })
    return {
      id: typeof id === 'number' ? id : Number(id),
      key: series.key,
      subject: series.subject,
      deviceId: series.deviceId,
      scope: series.scope,
      firstTs: series.ts,
      lastTs: series.ts,
    }
  }

  async touchSeries(updates: readonly SeriesSpanUpdate[]): Promise<void> {
    for (const batch of chunks(updates, TRANSACT_CHUNK)) {
      await this.door.transact.mutate({
        namespace: HISTORY_NAMESPACE,
        ops: batch.map((u) => ({
          op: 'update' as const,
          collection: COLLECTIONS.series,
          id: String(u.id),
          data: { last_ts: u.lastTs },
        })),
      })
    }
  }

  async widenSeriesStart(id: number, firstTs: number): Promise<void> {
    await this.door.update.mutate({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.series,
      id: String(id),
      data: { first_ts: firstTs },
    })
  }

  // ── raw ────────────────────────────────────────────────────────────

  async upsertRaw(rows: readonly { seriesId: number; ts: number; value: number }[]): Promise<void> {
    for (const batch of chunks(rows, WRITE_CHUNK)) {
      await this.door.upsertMany.mutate({
        namespace: HISTORY_NAMESPACE,
        collection: COLLECTIONS.raw,
        conflict: ['series_id', 'ts'],
        records: batch.map((r) => ({ data: { series_id: r.seriesId, ts: r.ts, value: r.value } })),
      })
    }
  }

  /** Points of a series in `[from, toInclusive]`, ascending, at most `limit`. */
  async readRaw(
    seriesId: number,
    from: number,
    toInclusive: number,
    limit: number,
    direction: 'asc' | 'desc' = 'asc',
  ): Promise<readonly RawPoint[]> {
    const rows = await this.door.query.query({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.raw,
      filter: {
        where: { series_id: seriesId },
        whereBetween: { ts: [from, toInclusive] },
        orderBy: { field: 'ts', direction },
        limit,
      },
    })
    return rows.map((r) => ({ ts: readNumber(r.data, 'ts'), value: readNumber(r.data, 'value') }))
  }

  /** The newest raw point strictly before `ts`, if any. */
  async rawBefore(seriesId: number, ts: number): Promise<RawPoint | null> {
    const rows = await this.readRaw(seriesId, 0, ts - 1, 1, 'desc')
    return rows[0] ?? null
  }

  // ── rollups ────────────────────────────────────────────────────────

  async upsertRollups(tier: RollupTier, rows: readonly RollupRow[]): Promise<void> {
    for (const batch of chunks(rows, WRITE_CHUNK)) {
      await this.door.upsertMany.mutate({
        namespace: HISTORY_NAMESPACE,
        collection: rollupCollectionOf(tier),
        conflict: ['series_id', 'bucket_start'],
        records: batch.map((r) => ({ data: rollupData(r) })),
      })
    }
  }

  async readRollups(
    tier: RollupTier,
    seriesId: number,
    from: number,
    toInclusive: number,
    limit: number,
    direction: 'asc' | 'desc' = 'asc',
  ): Promise<readonly RollupRow[]> {
    const rows = await this.door.query.query({
      namespace: HISTORY_NAMESPACE,
      collection: rollupCollectionOf(tier),
      filter: {
        where: { series_id: seriesId },
        whereBetween: { bucket_start: [from, toInclusive] },
        orderBy: { field: 'bucket_start', direction },
        limit,
      },
    })
    return rows.map((r) => parseRollup(r.data))
  }

  /** The newest rollup row of `tier` strictly before `bucketStart`, if any. */
  async rollupBefore(
    tier: RollupTier,
    seriesId: number,
    bucketStart: number,
  ): Promise<RollupRow | null> {
    const rows = await this.readRollups(tier, seriesId, 0, bucketStart - 1, 1, 'desc')
    return rows[0] ?? null
  }

  // ── deletes and counts ─────────────────────────────────────────────

  /** Delete one series' rows of a tier with the order column in `[lo, hiInclusive]`. */
  async deleteRange(
    tier: StoredTier,
    seriesId: number,
    lo: number,
    hiInclusive: number,
  ): Promise<number> {
    const { deleted } = await this.door.deleteWhere.mutate({
      namespace: HISTORY_NAMESPACE,
      collection: collectionOf(tier),
      filter: {
        where: { series_id: seriesId },
        whereBetween: { [orderColumnOf(tier)]: [lo, hiInclusive] },
      },
    })
    return deleted
  }

  /** Delete every row of one series, in every tier, then the series row. */
  async deleteSeries(seriesId: number): Promise<void> {
    for (const tier of ['raw', '5m', '1h', '1d'] as const) {
      await this.door.deleteWhere.mutate({
        namespace: HISTORY_NAMESPACE,
        collection: collectionOf(tier),
        filter: { where: { series_id: seriesId } },
      })
    }
    await this.door.delete.mutate({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.series,
      key: String(seriesId),
    })
  }

  /**
   * One series' rows of a tier: a range of the primary key (`series_id = ?`),
   * never a scan of the tier (D447, asserted in `history-query-plans.spec.ts`).
   */
  async countSeriesRows(tier: StoredTier, seriesId: number): Promise<number> {
    return this.door.count.query({
      namespace: HISTORY_NAMESPACE,
      collection: collectionOf(tier),
      filter: { where: { series_id: seriesId } },
    })
  }

  async countRows(tier: StoredTier): Promise<number> {
    return this.door.count.query({ namespace: HISTORY_NAMESPACE, collection: collectionOf(tier) })
  }

  // ── opt-outs (camstack.db) ─────────────────────────────────────────

  async loadOptOuts(): Promise<ReadonlySet<number>> {
    const rows = await this.door.query.query({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.optOuts,
      filter: { limit: 20_000 },
    })
    return new Set(rows.map((r) => readNumber(r.data, 'device_id')))
  }

  async setOptOut(deviceId: number, at: number): Promise<void> {
    await this.door.upsertMany.mutate({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.optOuts,
      conflict: ['device_id'],
      records: [{ data: { device_id: deviceId, opted_out_at: at } }],
    })
  }

  async loadDepartures(): Promise<ReadonlyMap<number, number>> {
    const rows = await this.door.query.query({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.departures,
      filter: { limit: 20_000 },
    })
    return new Map(
      rows.map((r) => [readNumber(r.data, 'device_id'), readNumber(r.data, 'missing_since')]),
    )
  }

  async markMissing(deviceIds: readonly number[], at: number): Promise<void> {
    for (const batch of chunks(deviceIds, WRITE_CHUNK)) {
      await this.door.upsertMany.mutate({
        namespace: HISTORY_NAMESPACE,
        collection: COLLECTIONS.departures,
        conflict: ['device_id'],
        records: batch.map((id) => ({ data: { device_id: id, missing_since: at } })),
      })
    }
  }

  async clearMissing(deviceIds: readonly number[]): Promise<void> {
    for (const batch of chunks(deviceIds, WRITE_CHUNK)) {
      await this.door.deleteWhere.mutate({
        namespace: HISTORY_NAMESPACE,
        collection: COLLECTIONS.departures,
        filter: { whereIn: { device_id: [...batch] } },
      })
    }
  }

  async clearOptOut(deviceId: number): Promise<void> {
    await this.door.deleteWhere.mutate({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.optOuts,
      filter: { where: { device_id: deviceId } },
    })
  }

  /** True when this rescale already finished. A missing row is "not yet". */
  async scaleApplied(id: string): Promise<boolean> {
    const rows = await this.door.query.query({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.appliedScales,
      filter: { where: { id }, limit: 1 },
    })
    return rows.length > 0
  }

  async markScale(id: string, at: number): Promise<void> {
    await this.door.upsertMany.mutate({
      namespace: HISTORY_NAMESPACE,
      collection: COLLECTIONS.appliedScales,
      conflict: ['id'],
      records: [{ id, data: { id, applied_at: at } }],
    })
  }

  /**
   * Multiply one series' raw points and rollups that are still in the old
   * unit. Points already at or above `legacyMax` stay. Returns how many rows
   * changed.
   */
  async scaleSeries(seriesId: number, factor: number, legacyMax: number): Promise<number> {
    const raw = await this.scaleRaw(seriesId, factor, legacyMax)
    let rollups = 0
    for (const tier of ['5m', '1h', '1d'] as const) {
      rollups += await this.scaleRollupTier(tier, seriesId, factor, legacyMax)
    }
    return raw + rollups
  }

  private async scaleRaw(seriesId: number, factor: number, legacyMax: number): Promise<number> {
    let after = -1
    let changed = 0
    for (;;) {
      const rows = await this.readRaw(
        seriesId,
        after + 1,
        Number.MAX_SAFE_INTEGER,
        READ_PAGE,
        'asc',
      )
      if (rows.length === 0) break
      const next = rows.flatMap((row) => {
        const value = scaledMagnitude(row.value, factor, legacyMax)
        return value === row.value ? [] : [{ seriesId, ts: row.ts, value }]
      })
      if (next.length > 0) {
        await this.upsertRaw(next)
        changed += next.length
      }
      const last = rows[rows.length - 1]
      if (last === undefined || rows.length < READ_PAGE) break
      after = last.ts
    }
    return changed
  }

  private async scaleRollupTier(
    tier: RollupTier,
    seriesId: number,
    factor: number,
    legacyMax: number,
  ): Promise<number> {
    let after = -1
    let changed = 0
    for (;;) {
      const rows = await this.readRollups(
        tier,
        seriesId,
        after + 1,
        Number.MAX_SAFE_INTEGER,
        READ_PAGE,
        'asc',
      )
      if (rows.length === 0) break
      const next = rows.flatMap((row) =>
        rollupIsLegacy(row, legacyMax) ? [scaleRollup(row, factor)] : [],
      )
      if (next.length > 0) {
        await this.upsertRollups(tier, next)
        changed += next.length
      }
      const last = rows[rows.length - 1]
      if (last === undefined || rows.length < READ_PAGE) break
      after = last.bucketStart
    }
    return changed
  }
}

function scaleRollup(row: RollupRow, factor: number): RollupRow {
  return {
    ...row,
    sum: row.sum * factor,
    min: row.min * factor,
    max: row.max * factor,
    last: row.last === null ? null : row.last * factor,
    twSum: row.twSum === null ? null : row.twSum * factor,
  }
}
