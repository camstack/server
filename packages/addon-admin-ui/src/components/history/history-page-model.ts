/**
 * The pure half of the cross-device History page: the series catalogue the
 * picker filters, the built-in panels, and how a selection splits into one
 * overlay (lines on an axis per unit, states as timelines, energy as bars).
 */
import {
  DEVICE_HISTORY_ENERGY_KEY,
  type DeviceHistoryQueryManyItem,
  type DeviceHistorySeriesInfo,
} from '@camstack/types'
import {
  HISTORY_SELECTION_MAX,
  normalizeSelection,
  resolveDeviceLabel,
  seriesRefId,
  type DeviceNameIndex,
  type DeviceNameNouns,
  type HistorySeriesRef,
} from '@camstack/ui-library'

/** One pickable series, with what the picker searches and facets on. */
export interface SeriesCandidate {
  readonly id: string
  readonly ref: HistorySeriesRef
  readonly info: DeviceHistorySeriesInfo
  /** Device or node name. */
  readonly subjectName: string
  /** Room / location of a device; `''` for a node or a device with none. */
  readonly location: string
  /** The node a node series belongs to; `''` for a device. */
  readonly nodeId: string
  /** The series label: its display name, plus its scope when it has one. */
  readonly metric: string
}

export interface CatalogDevice {
  readonly id: number
  readonly name: string
  readonly location: string | null
}

export interface CatalogNode {
  readonly id: string
  readonly name: string
}

function metricOf(
  info: DeviceHistorySeriesInfo,
  scopeName?: (info: DeviceHistorySeriesInfo) => string,
): string {
  if (info.scope === '') return info.displayName
  return `${info.displayName} · ${scopeName?.(info) ?? info.scope}`
}

/** Flatten every device's and node's series into picker candidates. */
export function buildCatalog(
  devices: readonly {
    readonly device: CatalogDevice
    readonly series: readonly DeviceHistorySeriesInfo[]
  }[],
  nodes: readonly {
    readonly node: CatalogNode
    readonly series: readonly DeviceHistorySeriesInfo[]
  }[],
  scopeName?: (info: DeviceHistorySeriesInfo) => string,
): readonly SeriesCandidate[] {
  const out: SeriesCandidate[] = []
  for (const { device, series } of devices) {
    for (const info of series) {
      const ref: HistorySeriesRef = {
        subject: { kind: 'device', deviceId: device.id },
        key: info.key,
        scope: info.scope,
      }
      out.push({
        id: seriesRefId(ref),
        ref,
        info,
        subjectName: device.name,
        location: device.location ?? '',
        nodeId: '',
        metric: metricOf(info, scopeName),
      })
    }
  }
  for (const { node, series } of nodes) {
    for (const info of series) {
      const ref: HistorySeriesRef = {
        subject: { kind: 'node', nodeId: node.id },
        key: info.key,
        scope: info.scope,
      }
      out.push({
        id: seriesRefId(ref),
        ref,
        info,
        subjectName: node.name,
        location: '',
        nodeId: node.id,
        metric: metricOf(info, scopeName),
      })
    }
  }
  return out
}

/** What the picker's search matches: subject, room, metric, key, unit. */
export function candidateSearchText(c: SeriesCandidate): string {
  return [c.subjectName, c.location, c.metric, c.info.key, c.info.unit ?? '', c.nodeId].join(' ')
}

/** The name the history charts and picker paint. Search keeps `subjectName`. */
export function seriesSubjectLabel(
  candidate: SeriesCandidate,
  index: DeviceNameIndex | null,
  nouns: DeviceNameNouns,
): string {
  if (candidate.ref.subject.kind !== 'device' || index === null) return candidate.subjectName
  const device = index.byId.get(candidate.ref.subject.deviceId)
  if (device === undefined) return candidate.subjectName
  return resolveDeviceLabel(device, 'compact', index, nouns)
}

// ── Built-in panels ─────────────────────────────────────────────────────

export type BuiltInPanelId = 'energy' | 'temperatures' | 'nodes' | 'storage'

export const BUILT_IN_PANELS: readonly BuiltInPanelId[] = [
  'energy',
  'temperatures',
  'nodes',
  'storage',
]

const TEMPERATURE_KEYS: ReadonlySet<string> = new Set([
  'cap:temperature-sensor.celsius',
  'cap:climate-control.currentTemp',
])

const NODE_TOTAL_KEYS: readonly string[] = [
  'addon:metrics-native/node-cpu-percent',
  'addon:metrics-native/node-memory-percent',
]

const STORAGE_KEY = 'addon:storage-orchestrator/location-used-percent'

/**
 * The selection a built-in panel means over the catalogue as it stands:
 * every device's energy; every room temperature, sorted by room; each node's
 * CPU and memory; each storage location's used share. At most
 * {@link HISTORY_SELECTION_MAX}.
 */
export function builtInSelection(
  panel: BuiltInPanelId,
  catalog: readonly SeriesCandidate[],
): readonly HistorySeriesRef[] {
  const pick = (
    pred: (c: SeriesCandidate) => boolean,
    order?: (a: SeriesCandidate, b: SeriesCandidate) => number,
  ) => {
    const list = catalog.filter(pred)
    return normalizeSelection((order ? [...list].sort(order) : list).map((c) => c.ref))
  }
  switch (panel) {
    case 'energy':
      return pick(
        (c) => c.ref.subject.kind === 'device' && c.info.key === DEVICE_HISTORY_ENERGY_KEY,
      )
    case 'temperatures':
      return pick(
        (c) =>
          c.ref.subject.kind === 'device' &&
          TEMPERATURE_KEYS.has(c.info.key) &&
          c.info.scope === '',
        (a, b) =>
          a.location.localeCompare(b.location) || a.subjectName.localeCompare(b.subjectName),
      )
    case 'nodes':
      return pick(
        (c) =>
          c.ref.subject.kind === 'node' &&
          NODE_TOTAL_KEYS.includes(c.info.key) &&
          c.info.scope === '',
        (a, b) =>
          NODE_TOTAL_KEYS.indexOf(a.info.key) - NODE_TOTAL_KEYS.indexOf(b.info.key) ||
          a.subjectName.localeCompare(b.subjectName),
      )
    case 'storage':
      return pick((c) => c.ref.subject.kind === 'node' && c.info.key === STORAGE_KEY)
  }
}

// ── Overlay ─────────────────────────────────────────────────────────────

export interface OverlayPart {
  /** Gauges and counters: one line chart, one value axis per unit. */
  readonly lines: readonly SeriesCandidate[]
  /** Booleans and enums: one timeline, a row each. */
  readonly states: readonly SeriesCandidate[]
  /** Derived energy: one bar chart, a stacked layer each. */
  readonly energy: readonly SeriesCandidate[]
  /** Selected refs the catalogue no longer has (device gone, series aged out). */
  readonly missing: readonly HistorySeriesRef[]
}

/** Split a selection by how each series is drawn. */
export function splitOverlay(
  selection: readonly HistorySeriesRef[],
  catalog: readonly SeriesCandidate[],
): OverlayPart {
  const byId = new Map(catalog.map((c) => [c.id, c] as const))
  const lines: SeriesCandidate[] = []
  const states: SeriesCandidate[] = []
  const energy: SeriesCandidate[] = []
  const missing: HistorySeriesRef[] = []
  for (const ref of normalizeSelection(selection)) {
    const c = byId.get(seriesRefId(ref))
    if (c === undefined) {
      missing.push(ref)
      continue
    }
    if (c.info.key === DEVICE_HISTORY_ENERGY_KEY) energy.push(c)
    else if (c.info.kind === 'boolean' || c.info.kind === 'enum') states.push(c)
    else lines.push(c)
  }
  return { lines, states, energy, missing }
}

/** The `queryMany` item that reads exactly this ref. */
export function readItemOf(ref: HistorySeriesRef): DeviceHistoryQueryManyItem {
  return ref.subject.kind === 'device'
    ? { deviceId: ref.subject.deviceId, key: ref.key, scope: ref.scope }
    : { forNodeId: ref.subject.nodeId, key: ref.key, scope: ref.scope }
}

/** Can one more series join the overlay? */
export function selectionHasRoom(selection: readonly HistorySeriesRef[]): boolean {
  return selection.length < HISTORY_SELECTION_MAX
}
