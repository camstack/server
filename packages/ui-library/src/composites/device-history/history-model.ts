/**
 * The pure half of a device's History view: which charts a device's series
 * make, in which sections, and how a `query` answer becomes chart data.
 *
 * Grouping mirrors the State panel: one section per capability in
 * `HISTORY_CATALOG` order (its fields in catalog order), then one section per
 * producer addon, sorted. Inside a section: one line chart per UNIT (never
 * two units on one axis), one state timeline per boolean or enum, the
 * derived energy as bars. A camera's occupancy is ONE chart of every
 * (zone × class) scope.
 */
import {
  DEVICE_HISTORY_ENERGY_KEY,
  HISTORY_CATALOG,
  parseOccupancyScope,
  type DeviceHistoryQueryPoint,
  type DeviceHistoryQueryResult,
  type DeviceHistorySeriesInfo,
} from '@camstack/types'
import type { BarBucket } from '../charts/bar-series-model'
import type { StateChange, StateSegment, TimePoint } from '../charts/chart-data'
import { segmentsFromChanges } from '../charts/chart-data'
import { gapThresholdMs } from '../charts/chart-scale'
import { RESOLUTION_BUCKET_MS } from './history-window'

/** The producer series a camera's occupancy chart reads. */
export const OCCUPANCY_KEY = 'addon:pipeline-analytics/occupancy'

export type HistoryChartSpec =
  | {
      readonly type: 'lines'
      readonly id: string
      readonly title: string
      readonly unit: string | null
      readonly series: readonly DeviceHistorySeriesInfo[]
    }
  | {
      readonly type: 'states'
      readonly id: string
      readonly title: string
      readonly series: DeviceHistorySeriesInfo
    }
  | {
      readonly type: 'energy'
      readonly id: string
      readonly title: string
      readonly series: DeviceHistorySeriesInfo
    }
  | {
      readonly type: 'occupancy'
      readonly id: string
      readonly title: string
      readonly series: readonly DeviceHistorySeriesInfo[]
    }

export interface HistorySection {
  readonly id: string
  /** `cap` — a capability's fields; `producer` — an addon's declared series. */
  readonly kind: 'cap' | 'producer'
  /** Capability name or producer addon id. */
  readonly name: string
  readonly charts: readonly HistoryChartSpec[]
}

/** `cap:<capName>.<fieldPath>` → its parts; `null` for any other key. */
export function parseCapKey(key: string): { readonly cap: string; readonly field: string } | null {
  if (!key.startsWith('cap:')) return null
  const body = key.slice(4)
  const dot = body.indexOf('.')
  if (dot <= 0) return null
  return { cap: body.slice(0, dot), field: body.slice(dot + 1) }
}

/** `addon:<addonId>/<name>` → its parts; `null` for any other key. */
export function parseProducerKey(
  key: string,
): { readonly addonId: string; readonly name: string } | null {
  if (!key.startsWith('addon:')) return null
  const body = key.slice(6)
  const slash = body.indexOf('/')
  if (slash <= 0) return null
  return { addonId: body.slice(0, slash), name: body.slice(slash + 1) }
}

const CATALOG_CAPS: readonly string[] = Object.keys(HISTORY_CATALOG)

function capRank(cap: string): number {
  const i = CATALOG_CAPS.indexOf(cap)
  return i < 0 ? CATALOG_CAPS.length : i
}

function fieldRank(cap: string, field: string): number {
  const fields = Object.keys(HISTORY_CATALOG[cap] ?? {})
  const i = fields.indexOf(field)
  return i < 0 ? fields.length : i
}

const isState = (s: DeviceHistorySeriesInfo): boolean => s.kind === 'boolean' || s.kind === 'enum'

/** One section's charts: a line chart per unit (first-seen order), then one timeline per state. */
function chartsOf(
  sectionId: string,
  title: string,
  list: readonly DeviceHistorySeriesInfo[],
): HistoryChartSpec[] {
  const out: HistoryChartSpec[] = []
  const byUnit = new Map<string, DeviceHistorySeriesInfo[]>()
  for (const s of list) {
    if (s.key === DEVICE_HISTORY_ENERGY_KEY) {
      out.push({ type: 'energy', id: `${sectionId}:energy`, title: s.displayName, series: s })
      continue
    }
    if (isState(s)) continue
    const u = s.unit ?? ''
    byUnit.set(u, [...(byUnit.get(u) ?? []), s])
  }
  const lines: HistoryChartSpec[] = [...byUnit.entries()].map(([unit, series]) => {
    const names = [...new Set(series.map((s) => s.displayName))]
    return {
      type: 'lines',
      id: `${sectionId}:unit:${unit}`,
      title: names.length === 1 ? (names[0] ?? title) : unit === '' ? title : `${title} (${unit})`,
      unit: unit === '' ? null : unit,
      series,
    }
  })
  const states: HistoryChartSpec[] = list.filter(isState).map((s) => ({
    type: 'states',
    id: `${sectionId}:state:${s.key}:${s.scope}`,
    title: s.displayName,
    series: s,
  }))
  return [...lines, ...out, ...states]
}

/**
 * Group a device's series into sections. Energy (a derived key) joins the
 * `power-meter` section when the device has one, else gets its own.
 */
export function groupDeviceSeries(
  series: readonly DeviceHistorySeriesInfo[],
  capTitle: (cap: string) => string,
): readonly HistorySection[] {
  const caps = new Map<string, DeviceHistorySeriesInfo[]>()
  const producers = new Map<string, DeviceHistorySeriesInfo[]>()
  const occupancy: DeviceHistorySeriesInfo[] = []
  let energy: DeviceHistorySeriesInfo | null = null
  for (const s of series) {
    if (s.key === DEVICE_HISTORY_ENERGY_KEY) {
      energy = s
      continue
    }
    if (s.key === OCCUPANCY_KEY) {
      occupancy.push(s)
      continue
    }
    const cap = parseCapKey(s.key)
    if (cap) {
      caps.set(cap.cap, [...(caps.get(cap.cap) ?? []), s])
      continue
    }
    const prod = parseProducerKey(s.key)
    const addon = prod?.addonId ?? 'other'
    producers.set(addon, [...(producers.get(addon) ?? []), s])
  }
  if (energy !== null) {
    if (caps.has('power-meter'))
      caps.set('power-meter', [...(caps.get('power-meter') ?? []), energy])
    else caps.set('energy', [energy])
  }
  const capSections: HistorySection[] = [...caps.entries()]
    .sort(([a], [b]) => capRank(a) - capRank(b) || a.localeCompare(b))
    .map(([cap, list]) => {
      const sorted = [...list].sort((x, y) => {
        const fx = parseCapKey(x.key)?.field ?? ''
        const fy = parseCapKey(y.key)?.field ?? ''
        return fieldRank(cap, fx) - fieldRank(cap, fy) || x.scope.localeCompare(y.scope)
      })
      const id = `cap:${cap}`
      return { id, kind: 'cap', name: cap, charts: chartsOf(id, capTitle(cap), sorted) }
    })
  if (occupancy.length > 0) {
    const list = producers.get('pipeline-analytics') ?? []
    producers.set('pipeline-analytics', list)
  }
  const producerSections: HistorySection[] = [...producers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([addon, list]) => {
      const id = `addon:${addon}`
      const charts = chartsOf(id, capTitle(addon), list)
      const occ: HistoryChartSpec[] =
        addon === 'pipeline-analytics' && occupancy.length > 0
          ? [
              {
                type: 'occupancy',
                id: `${id}:occupancy`,
                // i18n-ignore: unreachable fallback — the section exists only with a series
                title: occupancy[0]?.displayName ?? 'Occupancy',
                series: [...occupancy].sort((a, b) => a.scope.localeCompare(b.scope)),
              },
            ]
          : []
      return { id, kind: 'producer', name: addon, charts: [...occ, ...charts] }
    })
  return [...capSections, ...producerSections].filter((s) => s.charts.length > 0)
}

// ── Reads → chart data ──────────────────────────────────────────────────

/** The unique keys a set of charts reads (one `queryMany` item each: every scope comes back). */
export function chartKeys(charts: readonly HistoryChartSpec[]): readonly string[] {
  const keys = new Set<string>()
  for (const c of charts) {
    if (c.type === 'lines' || c.type === 'occupancy') for (const s of c.series) keys.add(s.key)
    else keys.add(c.series.key)
  }
  return [...keys]
}

/** One series of a `query` answer, found by scope. */
export function seriesOf(
  result: DeviceHistoryQueryResult | undefined,
  scope: string,
): DeviceHistoryQueryResult['series'][number] | undefined {
  return result?.series.find((s) => s.scope === scope)
}

/** The number a line shows for a point: time-weighted mean, else mean, else the last value. */
function levelOf(p: DeviceHistoryQueryPoint, kind: DeviceHistorySeriesInfo['kind']): number | null {
  if (kind === 'counter') return p.last
  return p.twMean ?? p.mean ?? p.last
}

/**
 * Line points for a gauge or counter. A rolled-up answer carries its
 * min/max (a band). A CAP series is change-only and held, so the window
 * opens on the value in force (`before`); a producer's buckets are not held
 * and an absent bucket is a hole.
 */
export function linePoints(
  info: DeviceHistorySeriesInfo,
  result: DeviceHistoryQueryResult | undefined,
  from: number,
): {
  readonly points: readonly TimePoint[]
  readonly gapMs: number | undefined
  readonly held: boolean
} {
  const s = seriesOf(result, info.scope)
  const rollup = result !== undefined && result.resolution !== 'raw'
  const held = info.source === 'cap'
  const points: TimePoint[] = (s?.points ?? []).map((p) => ({
    t: p.t,
    v: levelOf(p, info.kind),
    ...(rollup && info.kind === 'gauge' ? { min: p.min, max: p.max } : {}),
  }))
  if (held && s?.before && s.before.value !== null && (points[0]?.t ?? Infinity) > from) {
    points.unshift({ t: from, v: s.before.value })
  }
  const gapMs =
    held || result === undefined
      ? undefined
      : gapThresholdMs(
          result.resolution === 'raw' ? 10_000 : RESOLUTION_BUCKET_MS[result.resolution],
        )
  return { points, gapMs, held }
}

/** Shift every point by `shiftMs` (a previous period laid over the current one). */
export function shiftPoints(points: readonly TimePoint[], shiftMs: number): readonly TimePoint[] {
  return points.map((p) => ({ ...p, t: p.t + shiftMs }))
}

/** The state names a boolean series takes, `false` first. */
export const BOOLEAN_STATES: readonly ['false', 'true'] = ['false', 'true']

/**
 * A state series as segments plus the exact time spent in each state.
 *
 * Raw points are changes. A rollup bucket is drawn in its DOMINANT state
 * (the one held longest in it), while the totals add the bucket's real
 * per-state milliseconds — so "open 2h 14m" stays exact at any zoom.
 */
export function stateRow(
  info: DeviceHistorySeriesInfo,
  result: DeviceHistoryQueryResult | undefined,
  from: number,
  to: number,
): {
  readonly segments: readonly StateSegment[]
  readonly totals: ReadonlyMap<string, number>
  readonly states: readonly string[]
} {
  const states = info.kind === 'boolean' ? BOOLEAN_STATES : (info.values ?? [])
  const s = seriesOf(result, info.scope)
  const nameOf = (p: DeviceHistoryQueryPoint): string | null =>
    info.kind === 'boolean' ? (p.last === null ? null : p.last >= 0.5 ? 'true' : 'false') : p.state
  if (result === undefined || s === undefined) return { segments: [], totals: new Map(), states }
  const beforeState =
    s.before === null
      ? null
      : info.kind === 'boolean'
        ? s.before.value === null
          ? null
          : s.before.value >= 0.5
            ? 'true'
            : 'false'
        : s.before.state
  if (result.resolution === 'raw') {
    const changes: StateChange[] = s.points.map((p) => ({ t: p.t, state: nameOf(p) }))
    const segments = segmentsFromChanges(changes, from, to, beforeState)
    const totals = new Map<string, number>()
    for (const seg of segments) {
      if (seg.state !== null)
        totals.set(seg.state, (totals.get(seg.state) ?? 0) + (seg.to - seg.from))
    }
    return { segments, totals, states }
  }
  const bucketMs = RESOLUTION_BUCKET_MS[result.resolution]
  const totals = new Map<string, number>()
  const segments: StateSegment[] = []
  for (const p of s.points) {
    const end = Math.min(to, p.t + bucketMs)
    const start = Math.max(from, p.t)
    if (!(end > start)) continue
    const perState = bucketStates(p, info, bucketMs)
    let dominant: string | null = null
    let best = -1
    for (const [name, ms] of perState) {
      totals.set(name, (totals.get(name) ?? 0) + ms * ((end - start) / bucketMs))
      if (ms > best) {
        best = ms
        dominant = name
      }
    }
    const prev = segments.at(-1)
    if (prev && prev.state === dominant && prev.to === start) {
      segments[segments.length - 1] = { ...prev, to: end }
    } else {
      segments.push({ from: start, to: end, state: dominant })
    }
  }
  return { segments: segments.filter((x) => x.state !== null), totals, states }
}

function bucketStates(
  p: DeviceHistoryQueryPoint,
  info: DeviceHistorySeriesInfo,
  bucketMs: number,
): ReadonlyMap<string, number> {
  if (info.kind === 'boolean') {
    const frac = p.twMean ?? p.mean
    if (frac === null) {
      return p.last === null ? new Map() : new Map([[p.last >= 0.5 ? 'true' : 'false', bucketMs]])
    }
    return new Map([
      ['true', frac * bucketMs],
      ['false', (1 - frac) * bucketMs],
    ])
  }
  if (p.states) return new Map(Object.entries(p.states))
  return p.state === null ? new Map() : new Map([[p.state, bucketMs]])
}

/** Energy bars: one bucket per point, the kWh used in it (`delta`). */
export function energyBuckets(result: DeviceHistoryQueryResult | undefined): {
  readonly buckets: readonly BarBucket[]
  readonly bucketMs: number
} {
  const s = result?.series[0]
  const bucketMs =
    result === undefined || result.resolution === 'raw'
      ? RESOLUTION_BUCKET_MS['1h']
      : RESOLUTION_BUCKET_MS[result.resolution]
  return { buckets: (s?.points ?? []).map((p) => ({ t: p.t, values: [p.delta] })), bucketMs }
}

// ── Occupancy (zone × class) ────────────────────────────────────────────

export interface OccupancyScopeLine {
  readonly scope: string
  /** `''` = the whole frame. */
  readonly zoneId: string
  /** `undefined` = every class. */
  readonly className: string | undefined
}

export function occupancyLines(
  series: readonly DeviceHistorySeriesInfo[],
): readonly OccupancyScopeLine[] {
  return series.map((s) => {
    const parsed = parseOccupancyScope(s.scope)
    return { scope: s.scope, zoneId: parsed.zoneId, className: parsed.className }
  })
}

/** The filter values an occupancy chart offers: zones and classes that exist. */
export function occupancyFacets(lines: readonly OccupancyScopeLine[]): {
  readonly zones: readonly string[]
  readonly classes: readonly string[]
} {
  const zones = [...new Set(lines.map((l) => l.zoneId))].sort()
  const classes = [
    ...new Set(lines.flatMap((l) => (l.className === undefined ? [] : [l.className]))),
  ].sort()
  return { zones, classes }
}

/** `null` = all. */
export interface OccupancyFilter {
  readonly zone: string | null
  readonly className: string | null
}

/**
 * The lines a filter keeps. With no class picked the per-zone AGGREGATE lines
 * show (summing classes again would double count); a class shows that class
 * in every (or the picked) zone.
 */
export function filterOccupancyLines(
  lines: readonly OccupancyScopeLine[],
  filter: OccupancyFilter,
): readonly OccupancyScopeLine[] {
  return lines.filter(
    (l) =>
      (filter.zone === null || l.zoneId === filter.zone) &&
      (filter.className === null ? l.className === undefined : l.className === filter.className),
  )
}
