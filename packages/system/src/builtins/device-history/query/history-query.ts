/**
 * Reads: `listSeries`, `query` and `queryMany` (plan §5.1).
 *
 * `auto` resolution picks the finest tier whose retention covers `from` and
 * whose point count fits `maxPoints`: a rollup tier fits when
 * `ceil(range / bucket) <= maxPoints`, raw fits when a read of `maxPoints + 1`
 * rows comes back short. The coarsest covering tier is the last resort and is
 * truncated to its newest `maxPoints` points (`truncated: true`) rather than
 * answering nothing. A series fed by closed buckets has NO raw rows, so raw is
 * never a candidate for it: an empty raw read "fits" every window.
 *
 * `before` is the last point strictly before the window in the chosen tier, so a
 * step chart can start at the value in force when the window opens — a quiet
 * bucket has no row, and the held value is otherwise invisible.
 *
 * {@link DEVICE_HISTORY_ENERGY_KEY} is computed here at read time, never stored:
 * the device's `kwhTotal` meter when it has one (per-bucket growth), else the
 * time-weighted integral of its `watts` (`tw_sum`, already in every rollup).
 * One place makes that choice, so two charts of one device cannot disagree, and
 * it covers every hour of history recorded before the key existed.
 */
import {
  type CapabilityHistoryField,
  type CapabilityHistoryItems,
  DEVICE_HISTORY_ENERGY_KEY,
  type DeviceHistoryQueryManyEntry,
  type DeviceHistoryQueryManyItem,
  type DeviceHistoryQueryPoint,
  type DeviceHistoryResolution,
  type DeviceHistorySeriesInfo,
  type DeviceHistorySubject,
  type ReadingQuantity,
  historyUnitFor,
} from '@camstack/types'
import type { RawPoint, RollupRow } from '../rollup/rollup-math.js'
import { type RetentionPolicy } from '../retention/retention.js'
import type { HistoryStore, SeriesRecord } from '../store/history-store.js'
import { type SeriesRegistry, subjectIdOf } from '../store/series-registry.js'
import { DAY_MS, FIVE_MINUTES_MS, HOUR_MS, bucketStartOf } from '../time/bucket-time.js'
import {
  CAP_KEY_PREFIX,
  type HistoryCatalog,
  type HistoryItemCatalog,
  capItemSeriesKey,
  capSeriesKey,
} from '../capture/capture-engine.js'
import { readPath, readUnit } from '../capture/field-path.js'
import {
  type SeriesMeaning,
  integratedEnergyPoints,
  rawPoints,
  rollupPoints,
  stateName,
} from './point-shape.js'

type Tier = DeviceHistoryResolution
type RollupTier = '5m' | '1h' | '1d'

const TIER_ORDER: readonly Tier[] = ['raw', '5m', '1h', '1d']
const BUCKET_MS: Readonly<Record<RollupTier, number>> = {
  '5m': FIVE_MINUTES_MS,
  '1h': HOUR_MS,
  '1d': DAY_MS,
}
/** A key with more scopes than this is cut (a zone x class matrix, not a chart). */
const MAX_SCOPES = 50

/** The power-meter series the energy key is derived from, meter first. */
export const ENERGY_METER_KEY: string = capSeriesKey('power-meter', 'kwhTotal')
export const ENERGY_POWER_KEY: string = capSeriesKey('power-meter', 'watts')

/**
 * Series whose quantity is chosen per device (D944). Weather is not here:
 * each weather field has its own quantity on the capability, and the catalog
 * unit is that base. A past weather point stored in another unit cannot be
 * rescaled — the unit at sample time was not kept.
 */
const DEVICE_QUANTITY_KEYS: ReadonlySet<string> = new Set([capSeriesKey('numeric-sensor', 'value')])

export interface QueryInput {
  readonly key: string
  readonly subject: DeviceHistorySubject
  readonly scope?: string
  readonly from: number
  readonly to: number
  readonly resolution: Tier | 'auto'
  readonly maxPoints: number
}

export interface QueryBefore {
  readonly t: number
  readonly value: number | null
  readonly state: string | null
}

export interface QuerySeries {
  readonly scope: string
  readonly before: QueryBefore | null
  readonly points: readonly DeviceHistoryQueryPoint[]
  readonly derivedFrom: string | null
}

export interface QueryOutput {
  readonly resolution: Tier
  readonly series: readonly QuerySeries[]
  readonly truncated: boolean
}

export interface QueryManyInput {
  readonly items: readonly DeviceHistoryQueryManyItem[]
  readonly from: number
  readonly to: number
  readonly resolution: Tier | 'auto'
  readonly maxPoints: number
}

export interface QueryDeps {
  readonly registry: SeriesRegistry
  readonly store: HistoryStore
  readonly clock: () => number
  readonly retention: () => RetentionPolicy
  readonly catalog: HistoryCatalog
  readonly itemCatalog: HistoryItemCatalog
  /** The device's current slice of a cap, for a `unitFrom` series; `null` when unreadable. */
  readonly readCapSlice: (
    deviceId: number,
    capName: string,
  ) => Promise<Readonly<Record<string, unknown>> | null>
  /** `null` when the device has no chosen quantity. A failed read is `null`. */
  readonly readDeviceQuantity?: (deviceId: number) => Promise<ReadingQuantity | null>
}

function retentionMsOf(tier: Tier, policy: RetentionPolicy): number | null {
  if (tier === 'raw') return policy.rawDays * DAY_MS
  if (tier === '5m') return policy.fiveMinuteDays * DAY_MS
  if (tier === '1h') return policy.hourDays * DAY_MS
  return policy.dayDays === null || policy.dayDays <= 0 ? null : policy.dayDays * DAY_MS
}

/** Rows of one tier, oldest first, bounded to `maxPoints` (the newest kept). */
type TierRead =
  | {
      readonly tier: 'raw'
      readonly rows: readonly RawPoint[]
      readonly overflow: boolean
    }
  | {
      readonly tier: RollupTier
      readonly rows: readonly RollupRow[]
      readonly overflow: boolean
    }

interface Bounded<T> {
  readonly rows: readonly T[]
  readonly overflow: boolean
}

/** The tier a query answers from, with each series' read of it. */
interface TierChoice {
  readonly chosen: Tier
  readonly reads: readonly (readonly [SeriesRecord, TierRead])[]
}

/** The stored series a device's energy is derived from. */
interface EnergySource {
  readonly series: SeriesRecord
  readonly from: 'meter' | 'power'
}

/** Rows arrive newest first and one over the bound; keep the newest `maxPoints`, oldest first. */
function bounded<T>(newestFirst: readonly T[], maxPoints: number): Bounded<T> {
  const overflow = newestFirst.length > maxPoints
  const kept = overflow ? newestFirst.slice(0, maxPoints) : newestFirst
  return { rows: kept.toReversed(), overflow }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class HistoryQuery {
  private readonly itemFields: ReadonlyMap<string, ItemField>

  constructor(private readonly deps: QueryDeps) {
    this.itemFields = itemFieldsByKey(deps.itemCatalog)
  }

  async query(input: QueryInput): Promise<QueryOutput> {
    if (input.key === DEVICE_HISTORY_ENERGY_KEY) return this.queryEnergy(input)
    const { registry } = this.deps
    const wanted = this.seriesOf(input)
    const metric = registry.metric(input.key)
    const meaning: SeriesMeaning = {
      kind: metric?.kind ?? 'gauge',
      values: metric?.values ?? null,
    }
    const { chosen, reads } = await this.choose(input, wanted, metric?.ingest === 'buckets')
    const series: QuerySeries[] = []
    for (const [s, read] of reads) {
      const before = await this.before(chosen, s, input.from, meaning)
      const points =
        read.tier === 'raw'
          ? rawPoints(read.rows, meaning, before?.value ?? null)
          : rollupPoints(read.rows, meaning, before?.value ?? null)
      series.push({ scope: s.scope, before, points, derivedFrom: null })
    }
    return {
      resolution: chosen,
      series,
      truncated: reads.some(([, r]) => r.overflow),
    }
  }

  /** Several reads over one window; one failing item answers its error, not the batch's. */
  async queryMany(input: QueryManyInput): Promise<readonly DeviceHistoryQueryManyEntry[]> {
    const out: DeviceHistoryQueryManyEntry[] = []
    // In order, one at a time: a batch must not fan a dashboard's reads onto the
    // history thread at once.
    for (const item of input.items) {
      const subject: DeviceHistorySubject =
        'deviceId' in item
          ? { kind: 'device', deviceId: item.deviceId }
          : { kind: 'node', nodeId: item.forNodeId }
      try {
        const result = await this.query({
          key: item.key,
          subject,
          ...(item.scope !== undefined ? { scope: item.scope } : {}),
          from: input.from,
          to: input.to,
          resolution: input.resolution,
          maxPoints: input.maxPoints,
        })
        out.push({ ok: true, result })
      } catch (err) {
        out.push({ ok: false, error: errorText(err) })
      }
    }
    return out
  }

  private seriesOf(input: QueryInput): readonly SeriesRecord[] {
    return this.deps.registry
      .forKeyAndSubject(input.key, subjectIdOf(input.subject))
      .filter((s) => input.scope === undefined || s.scope === input.scope)
      .toSorted((a, b) => a.scope.localeCompare(b.scope))
      .slice(0, MAX_SCOPES)
  }

  /** The tier to answer from and its reads. `noRaw`: the series has no raw rows to read. */
  private async choose(
    input: QueryInput,
    wanted: readonly SeriesRecord[],
    noRaw: boolean,
  ): Promise<TierChoice> {
    const covering = this.coveringTiers(input.from)
    const candidates = noRaw ? withoutRaw(covering) : covering
    const forced = input.resolution === 'auto' ? null : input.resolution
    const order = forced === null ? candidates : [noRaw && forced === 'raw' ? '5m' : forced]
    let chosen: Tier = order[order.length - 1] ?? '1d'
    let reads: readonly (readonly [SeriesRecord, TierRead])[] = []
    for (const [index, tier] of order.entries()) {
      const last = index === order.length - 1
      if (!this.fits(tier, input, wanted) && !last) continue
      chosen = tier
      reads = await Promise.all(
        wanted.map(async (s) => [s, await this.readTier(tier, s, input)] as const),
      )
      if (reads.some(([, r]) => r.overflow) && !last) continue
      break
    }
    return { chosen, reads }
  }

  /** Tiers whose retention covers `from`, finest first; the coarsest is always present. */
  private coveringTiers(from: number): readonly Tier[] {
    const policy = this.deps.retention()
    const now = this.deps.clock()
    const covering = TIER_ORDER.filter((tier) => {
      const ms = retentionMsOf(tier, policy)
      return ms === null || from >= now - ms
    })
    return covering.length > 0 ? covering : ['1d']
  }

  /** Cheap fit test for rollup tiers; raw is decided by the read itself. */
  private fits(tier: Tier, input: QueryInput, series: readonly SeriesRecord[]): boolean {
    if (tier === 'raw' || series.length === 0) return true
    const width = BUCKET_MS[tier]
    return Math.ceil((input.to - input.from) / width) <= input.maxPoints
  }

  private async readTier(tier: Tier, series: SeriesRecord, input: QueryInput): Promise<TierRead> {
    const { store } = this.deps
    const limit = input.maxPoints + 1
    if (tier === 'raw') {
      const rows = await store.readRaw(series.id, input.from, input.to, limit, 'desc')
      return { tier, ...bounded(rows, input.maxPoints) }
    }
    const lower = bucketStartOf(tier, input.from)
    const rows = await store.readRollups(tier, series.id, lower, input.to, limit, 'desc')
    return { tier, ...bounded(rows, input.maxPoints) }
  }

  private async before(
    tier: Tier,
    series: SeriesRecord,
    from: number,
    meaning: SeriesMeaning,
  ): Promise<QueryBefore | null> {
    const { store } = this.deps
    if (tier === 'raw') {
      const p = await store.rawBefore(series.id, from)
      return p === null ? null : { t: p.ts, value: p.value, state: stateName(meaning, p.value) }
    }
    const row = await store.rollupBefore(tier, series.id, bucketStartOf(tier, from))
    return row === null
      ? null
      : {
          t: row.bucketStart,
          value: row.last,
          state: stateName(meaning, row.last),
        }
  }

  // ── derived energy ─────────────────────────────────────────────────

  /** The series energy is derived from for a device: the meter when it has one, else its power. */
  private energySource(subject: DeviceHistorySubject): EnergySource | null {
    if (subject.kind !== 'device') return null
    const subjectId = subjectIdOf(subject)
    const meter = this.deps.registry.find(ENERGY_METER_KEY, subjectId, '')
    if (meter !== undefined) return { series: meter, from: 'meter' }
    const power = this.deps.registry.find(ENERGY_POWER_KEY, subjectId, '')
    return power === undefined ? null : { series: power, from: 'power' }
  }

  private async queryEnergy(input: QueryInput): Promise<QueryOutput> {
    const source = this.energySource(input.subject)
    if (source === null || (input.scope !== undefined && input.scope !== '')) {
      return { resolution: '5m', series: [], truncated: false }
    }
    // Energy is a per-bucket quantity: it is never answered from raw points.
    const { chosen, reads } = await this.choose(input, [source.series], true)
    const read = reads[0]?.[1]
    if (read === undefined || read.tier === 'raw') {
      return { resolution: chosen, series: [], truncated: false }
    }
    let points: readonly DeviceHistoryQueryPoint[]
    if (source.from === 'meter') {
      const prev = await this.deps.store.rollupBefore(
        read.tier,
        source.series.id,
        bucketStartOf(read.tier, input.from),
      )
      points = rollupPoints(read.rows, { kind: 'counter', values: null }, prev?.last ?? null)
    } else {
      points = integratedEnergyPoints(read.rows)
    }
    return {
      resolution: chosen,
      series: [{ scope: '', before: null, points, derivedFrom: source.series.key }],
      truncated: read.overflow,
    }
  }

  // ── listSeries ─────────────────────────────────────────────────────

  async listSeries(subject: DeviceHistorySubject): Promise<readonly DeviceHistorySeriesInfo[]> {
    const { registry } = this.deps
    const slices: SliceCache = new Map()
    const infos: DeviceHistorySeriesInfo[] = []
    for (const s of registry.forSubject(subjectIdOf(subject))) {
      const metric = registry.metric(s.key)
      if (metric === undefined) continue
      const item = this.itemFields.get(s.key)
      const named =
        item === undefined || subject.kind !== 'device'
          ? null
          : await this.itemNaming(subject.deviceId, item, s.scope, metric.unit, slices)
      infos.push({
        key: s.key,
        scope: s.scope,
        kind: metric.kind,
        unit: named !== null ? named.unit : await this.unitOf(subject, s, metric.unit, slices),
        displayName: named !== null ? `${named.label} · ${metric.displayName}` : metric.displayName,
        source: metric.source,
        values: metric.kind === 'enum' ? (metric.values ?? []) : null,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
      })
    }
    const energy = this.energySource(subject)
    if (energy !== null) {
      infos.push({
        key: DEVICE_HISTORY_ENERGY_KEY,
        scope: '',
        kind: 'counter',
        unit: 'kWh',
        displayName: 'Energy',
        source: 'derived',
        values: null,
        firstTs: energy.series.firstTs,
        lastTs: energy.series.lastTs,
      })
    }
    return infos.toSorted((a, b) => a.key.localeCompare(b.key) || a.scope.localeCompare(b.scope))
  }

  /**
   * An item series (D917) is named after its item and takes its `unitFrom`
   * from it, both read from the device's CURRENT slice: the item's `label`,
   * else its key (the scope) when the item is gone or the slice unreadable.
   */
  private async itemNaming(
    deviceId: number,
    item: ItemField,
    scope: string,
    fixed: string | null,
    slices: SliceCache,
  ): Promise<{ readonly label: string; readonly unit: string | null }> {
    const slice = await this.sliceOf(deviceId, item.capName, slices)
    const list = slice === null ? undefined : readPath(slice, item.items.path)
    const entry = Array.isArray(list)
      ? list.find(
          (e): e is Readonly<Record<string, unknown>> => isObject(e) && e[item.items.key] === scope,
        )
      : undefined
    const rawLabel =
      entry !== undefined && item.items.label !== undefined ? entry[item.items.label] : undefined
    const label = typeof rawLabel === 'string' && rawLabel.length > 0 ? rawLabel : scope
    if (fixed !== null || item.spec.unitFrom === undefined) return { label, unit: fixed }
    return {
      label,
      unit: entry === undefined ? null : readUnit(entry, item.spec.unitFrom),
    }
  }

  private sliceOf(
    deviceId: number,
    capName: string,
    slices: SliceCache,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const pending =
      slices.get(capName) ?? this.deps.readCapSlice(deviceId, capName).catch(() => null)
    slices.set(capName, pending)
    return pending
  }

  /** The metric's fixed unit, else the device's own (a `unitFrom` field), else unknown. */
  private async unitOf(
    subject: DeviceHistorySubject,
    series: SeriesRecord,
    fixed: string | null,
    slices: SliceCache,
  ): Promise<string | null> {
    if (fixed !== null || subject.kind !== 'device' || !series.key.startsWith(CAP_KEY_PREFIX)) {
      return fixed
    }
    if (DEVICE_QUANTITY_KEYS.has(series.key)) {
      const quantity = await this.quantityOf(subject.deviceId)
      if (quantity === null || quantity === 'device' || quantity === 'none') return null
      return historyUnitFor(quantity) ?? null
    }
    const spec = this.specOf(series.key)
    if (spec?.unitFrom === undefined) return null
    const capName = series.key.slice(CAP_KEY_PREFIX.length, series.key.indexOf('.'))
    const slice = await this.sliceOf(subject.deviceId, capName, slices)
    return slice === null ? null : readUnit(slice, spec.unitFrom)
  }

  private quantityOf(deviceId: number): Promise<ReadingQuantity | null> {
    const pending = this.quantities.get(deviceId)
    if (pending !== undefined) return pending
    const read = this.deps.readDeviceQuantity
    const run = read === undefined ? Promise.resolve(null) : read(deviceId).catch(() => null)
    this.quantities.set(deviceId, run)
    return run
  }

  private readonly quantities = new Map<number, Promise<ReadingQuantity | null>>()

  private specOf(key: string): CapabilityHistoryField | undefined {
    const body = key.slice(CAP_KEY_PREFIX.length)
    const dot = body.indexOf('.')
    if (dot < 0) return undefined
    return this.deps.catalog[body.slice(0, dot)]?.[body.slice(dot + 1)]
  }
}

type SliceCache = Map<string, Promise<Readonly<Record<string, unknown>> | null>>

/** One keyed-item field (D917), by its series key. */
interface ItemField {
  readonly capName: string
  readonly items: CapabilityHistoryItems
  readonly spec: CapabilityHistoryField
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Series key → keyed-item field, for every item field of the catalog. */
export function itemFieldsByKey(itemCatalog: HistoryItemCatalog): ReadonlyMap<string, ItemField> {
  return new Map(
    Object.entries(itemCatalog).flatMap(([capName, items]) =>
      Object.entries(items.fields).map(([field, spec]): [string, ItemField] => [
        capItemSeriesKey(capName, items, field),
        { capName, items, spec },
      ]),
    ),
  )
}

/** Every covering tier but raw; the coarsest stays when it is the only one. */
function withoutRaw(tiers: readonly Tier[]): readonly Tier[] {
  const rollups = tiers.filter((t) => t !== 'raw')
  return rollups.length > 0 ? rollups : ['5m']
}
