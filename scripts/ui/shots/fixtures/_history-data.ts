/**
 * Invented, deterministic device-history answers for the `history` fixture
 * area: series catalogues per device and per node, and a `query` / `queryMany`
 * answer computed from a smooth function of time, so a 24 h, 7 d, 30 d or 1 y
 * window all draw something plausible. Holes are deliberate: the camera's
 * analytics buckets stop for 90 minutes overnight (it was offline).
 */
import type {
  DeviceHistoryQueryPoint,
  DeviceHistoryQueryResult,
  DeviceHistoryResolution,
  DeviceHistorySeriesInfo,
} from '@camstack/types'
import { D, H, MINUTE, NOW } from './_time'

type Kind = DeviceHistorySeriesInfo['kind']

interface SeriesSpec {
  readonly key: string
  readonly scope: string
  readonly kind: Kind
  readonly unit: string | null
  readonly displayName: string
  readonly source: DeviceHistorySeriesInfo['source']
  readonly values: readonly string[] | null
  /** Value at `t`, `null` = nothing recorded there. Enum: the ordinal. */
  readonly at: (t: number) => number | null
}

const DAY_PHASE = (t: number): number => ((t % D) / D) * Math.PI * 2
const wave = (t: number, period: number, phase = 0): number =>
  Math.sin((t / period) * Math.PI * 2 + phase)
/** Hub-local "hour of day" against the fixed clock (UTC in the harness). */
const hourOf = (t: number): number => new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60

/** The camera was unreachable 02:00–03:30 every night of the fixture week. */
const cameraOffline = (t: number): boolean => {
  const h = hourOf(t)
  return h >= 2 && h < 3.5
}

const spec = (s: Omit<SeriesSpec, 'source' | 'values'> & Partial<SeriesSpec>): SeriesSpec => ({
  source: s.key.startsWith('addon:') ? 'addon' : s.key.startsWith('derived:') ? 'derived' : 'cap',
  values: null,
  ...s,
})

const DISHWASHER_STATES = ['idle', 'running', 'paused', 'finished', 'error', 'unavailable'] as const
/** Two cycles a day: 07:00–08:40 and 20:00–21:40, finished for 30 min after each. */
const dishwasherOrdinal = (t: number): number => {
  const h = hourOf(t)
  const inCycle = (start: number): boolean => h >= start && h < start + 1.66
  const justDone = (start: number): boolean => h >= start + 1.66 && h < start + 2.16
  if (inCycle(7) || inCycle(20)) return 1
  if (justDone(7) || justDone(20)) return 3
  return 0
}

const OCCUPANCY_SCOPES: readonly { scope: string; weight: number }[] = [
  { scope: '', weight: 1 },
  { scope: '|person', weight: 0.6 },
  { scope: '|vehicle', weight: 0.4 },
  { scope: 'driveway', weight: 0.7 },
  { scope: 'driveway|person', weight: 0.3 },
  { scope: 'driveway|vehicle', weight: 0.4 },
  { scope: 'porch', weight: 0.3 },
  { scope: 'porch|person', weight: 0.3 },
]

const occupancyAt =
  (weight: number) =>
  (t: number): number | null => {
    if (cameraOffline(t)) return null
    const h = hourOf(t)
    const busy = h > 6 && h < 22 ? 1 : 0.15
    return Math.max(0, Math.round((1.6 + 1.4 * wave(t, 3 * H)) * busy * weight * 3))
  }

export const DEVICE_SERIES: Readonly<Record<number, readonly SeriesSpec[]>> = {
  101: [
    spec({
      key: 'cap:device-status.online',
      scope: '',
      kind: 'boolean',
      unit: null,
      displayName: 'Online',
      at: (t) => (cameraOffline(t) ? 0 : 1),
    }),
    spec({
      key: 'addon:pipeline-analytics/motion',
      scope: '',
      kind: 'gauge',
      unit: null,
      displayName: 'Motion events (region count)',
      at: (t) => (cameraOffline(t) ? null : Math.max(0, Math.round(4 + 4 * wave(t, 2 * H)))),
    }),
    spec({
      key: 'addon:pipeline-analytics/audio-dbfs',
      scope: '',
      kind: 'gauge',
      unit: 'dBFS',
      displayName: 'Audio noise baseline (dBFS)',
      at: (t) => (cameraOffline(t) ? null : -62 + 6 * Math.sin(DAY_PHASE(t))),
    }),
    spec({
      key: 'addon:pipeline-analytics/audio-level',
      scope: '',
      kind: 'gauge',
      unit: 'dBFS',
      displayName: 'Audio level (dBFS)',
      at: (t) =>
        cameraOffline(t) ? null : -48 + 9 * Math.sin(DAY_PHASE(t)) + 4 * wave(t, 40 * MINUTE),
    }),
    ...OCCUPANCY_SCOPES.map((o) =>
      spec({
        key: 'addon:pipeline-analytics/occupancy',
        scope: o.scope,
        kind: 'gauge',
        unit: null,
        displayName: 'Occupancy count',
        at: occupancyAt(o.weight),
      }),
    ),
  ],
  201: [
    spec({
      key: 'cap:climate-control.currentTemp',
      scope: '',
      kind: 'gauge',
      unit: '°C',
      displayName: 'Current temperature',
      at: (t) => 20.6 + 1.4 * Math.sin(DAY_PHASE(t) - 1.2) + 0.2 * wave(t, 3 * H),
    }),
    spec({
      key: 'cap:climate-control.target',
      scope: '',
      kind: 'gauge',
      unit: '°C',
      displayName: 'Target',
      at: (t) => (hourOf(t) >= 6.5 && hourOf(t) < 22.5 ? 21 : 18),
    }),
    spec({
      key: 'cap:climate-control.currentHumidity',
      scope: '',
      kind: 'gauge',
      unit: '%',
      displayName: 'Humidity',
      at: (t) => 46 + 6 * Math.sin(DAY_PHASE(t) + 0.6),
    }),
    spec({
      key: 'cap:battery.level',
      scope: '',
      kind: 'gauge',
      unit: '%',
      displayName: 'Battery',
      at: (t) => 92 - ((t - (NOW - 365 * D)) / (365 * D)) * 35,
    }),
    spec({
      key: 'cap:device-status.online',
      scope: '',
      kind: 'boolean',
      unit: null,
      displayName: 'Online',
      at: () => 1,
    }),
  ],
  202: [
    spec({
      key: 'cap:dishwasher.state',
      scope: '',
      kind: 'enum',
      unit: null,
      displayName: 'Program state',
      values: DISHWASHER_STATES,
      at: dishwasherOrdinal,
    }),
    spec({
      key: 'cap:dishwasher.progressPercent',
      scope: '',
      kind: 'gauge',
      unit: '%',
      displayName: 'Progress',
      at: (t) => {
        const h = hourOf(t)
        for (const start of [7, 20])
          if (h >= start && h < start + 1.66) return ((h - start) / 1.66) * 100
        return 0
      },
    }),
    spec({
      key: 'cap:power-meter.power',
      scope: '',
      kind: 'gauge',
      unit: 'W',
      displayName: 'Power',
      at: (t) =>
        dishwasherOrdinal(t) === 1 ? 1180 + 620 * Math.max(0, wave(t, 25 * MINUTE)) : 1.4,
    }),
    spec({
      key: 'cap:power-meter.energy',
      scope: '',
      kind: 'counter',
      unit: 'kWh',
      displayName: 'Energy meter',
      at: (t) => 412 + ((t - (NOW - 365 * D)) / D) * 2.1,
    }),
    spec({
      key: 'derived:energy.kwh',
      scope: '',
      kind: 'counter',
      unit: 'kWh',
      displayName: 'Energy',
      at: (t) => (dishwasherOrdinal(t) === 1 ? 1 : 0.001),
    }),
    spec({
      key: 'cap:device-status.online',
      scope: '',
      kind: 'boolean',
      unit: null,
      displayName: 'Online',
      at: () => 1,
    }),
  ],
}

const RUNNERS = ['__root__', 'pipeline-runner', 'stream-broker', 'recorder'] as const
const LOCATIONS = ['recordings:fast-ssd', 'eventMedia:array'] as const

export const NODE_SERIES: Readonly<Record<string, readonly SeriesSpec[]>> = {
  hub: [
    spec({
      key: 'addon:metrics-native/node-cpu-percent',
      scope: '',
      kind: 'gauge',
      unit: '%',
      displayName: 'Node CPU',
      at: (t) => 22 + 10 * Math.sin(DAY_PHASE(t)) + 4 * wave(t, 50 * MINUTE),
    }),
    spec({
      key: 'addon:metrics-native/node-memory-percent',
      scope: '',
      kind: 'gauge',
      unit: '%',
      displayName: 'Node memory',
      at: (t) => 54 + 6 * wave(t, 9 * H),
    }),
    spec({
      key: 'addon:metrics-native/node-cpu-temperature',
      scope: '',
      kind: 'gauge',
      unit: '°C',
      displayName: 'CPU temperature',
      at: (t) => 48 + 7 * Math.sin(DAY_PHASE(t)),
    }),
    ...RUNNERS.map((r, i) =>
      spec({
        key: 'addon:metrics-native/runner-cpu-main-percent',
        scope: r,
        kind: 'gauge',
        unit: '%',
        displayName: 'Runner CPU (main threads)',
        at: (t) => Math.max(0, 3 + i * 4 + 3 * wave(t, (2 + i) * H, i)),
      }),
    ),
    ...LOCATIONS.map((l, i) =>
      spec({
        key: 'addon:storage-orchestrator/location-used-percent',
        scope: l,
        kind: 'gauge',
        unit: '%',
        displayName: 'Volume used',
        at: (t) => 41 + i * 28 + ((t - (NOW - 30 * D)) / (30 * D)) * 6,
      }),
    ),
  ],
  'garage-nuc': [
    spec({
      key: 'addon:metrics-native/node-cpu-percent',
      scope: '',
      kind: 'gauge',
      unit: '%',
      displayName: 'Node CPU',
      at: (t) => 38 + 14 * Math.sin(DAY_PHASE(t) + 0.8),
    }),
    spec({
      key: 'addon:metrics-native/node-memory-percent',
      scope: '',
      kind: 'gauge',
      unit: '%',
      displayName: 'Node memory',
      at: (t) => 61 + 4 * wave(t, 7 * H),
    }),
  ],
}

const RETAINED_FROM = NOW - 365 * D

/** Series info rows for a catalogue (`listSeries` / `listNodeSeries`). */
export function seriesInfo(list: readonly SeriesSpec[]): readonly DeviceHistorySeriesInfo[] {
  return list.map((s) => ({
    key: s.key,
    scope: s.scope,
    kind: s.kind,
    unit: s.unit,
    displayName: s.displayName,
    source: s.source,
    values: s.values === null ? null : [...s.values],
    firstTs: RETAINED_FROM,
    lastTs: NOW,
  }))
}

const BUCKET_MS: Readonly<Record<Exclude<DeviceHistoryResolution, 'raw'>, number>> = {
  '5m': 5 * MINUTE,
  '1h': H,
  '1d': D,
}

function resolutionFor(span: number): Exclude<DeviceHistoryResolution, 'raw'> {
  if (span <= 26 * H) return '5m'
  if (span <= 40 * D) return '1h'
  return '1d'
}

/** Sub-samples per bucket to derive min / max / mean / time in state. */
const PROBES = 6

function bucketPoint(s: SeriesSpec, t: number, bucketMs: number): DeviceHistoryQueryPoint | null {
  const vals: number[] = []
  const stateMs = new Map<string, number>()
  for (let k = 0; k < PROBES; k++) {
    const v = s.at(t + (bucketMs * (k + 0.5)) / PROBES)
    if (v === null) continue
    vals.push(v)
    if (s.kind === 'enum' && s.values) {
      const name = s.values[Math.round(v)] ?? 'unknown'
      stateMs.set(name, (stateMs.get(name) ?? 0) + bucketMs / PROBES)
    }
  }
  if (vals.length === 0) return null
  const last = vals.at(-1) ?? 0
  const sum = vals.reduce((a, b) => a + b, 0)
  if (s.kind === 'enum') {
    const lastState = s.values?.[Math.round(last)] ?? null
    return {
      t,
      samples: vals.length,
      mean: null,
      twMean: null,
      min: Math.min(...vals),
      max: Math.max(...vals),
      last: Math.round(last),
      delta: null,
      state: lastState,
      states: Object.fromEntries(stateMs),
    }
  }
  const mean = sum / vals.length
  const isEnergy = s.key === 'derived:energy.kwh'
  return {
    t,
    samples: vals.length,
    mean,
    twMean: s.source === 'addon' ? null : mean,
    min: Math.min(...vals),
    max: Math.max(...vals),
    last,
    delta: isEnergy ? (mean * bucketMs) / H : s.kind === 'counter' ? (2.1 * bucketMs) / D : null,
    state: null,
    states: null,
  }
}

/** The answer of `query` for one key (every scope unless `scope` is given). */
export function queryResult(
  list: readonly SeriesSpec[],
  key: string,
  scope: string | undefined,
  from: number,
  to: number,
): DeviceHistoryQueryResult {
  const resolution = resolutionFor(to - from)
  const bucketMs = BUCKET_MS[resolution]
  const start = Math.floor(from / bucketMs) * bucketMs
  const matching = list.filter((s) => s.key === key && (scope === undefined || s.scope === scope))
  return {
    resolution,
    truncated: false,
    series: matching.map((s) => {
      const points: DeviceHistoryQueryPoint[] = []
      for (let t = start; t < to; t += bucketMs) {
        const p = bucketPoint(s, t, bucketMs)
        if (p) points.push(p)
      }
      const prev = s.at(start - bucketMs)
      return {
        scope: s.scope,
        derivedFrom: s.key === 'derived:energy.kwh' ? 'cap:power-meter.energy' : null,
        before:
          prev === null
            ? null
            : {
                t: start - bucketMs,
                value: prev,
                state: s.kind === 'enum' ? (s.values?.[Math.round(prev)] ?? null) : null,
              },
        points,
      }
    }),
  }
}
