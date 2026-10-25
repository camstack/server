/**
 * Automatic shares from CAPACITY (D755). Pure.
 *
 * A node's share is its capacity in parallel sessions over the cluster's; a
 * device's share inside its node follows its throughput. There is no load
 * input: nothing here depends on how many sessions ran, only on what each
 * node can carry.
 *
 * Two places a capacity can come from:
 *  - `hardware` — each enabled accelerator at its Auto tune model, from the
 *    measured latency table: ⌊fps × (1 − headroom) / camera fps⌋ sessions;
 *  - `benchmark` — the node's own measured max sessions per device, read
 *    through a {@link NodeCapacitySource}. A node whose results do not cover
 *    every enabled device it would be sized on is sized from `hardware`
 *    instead, and the answer says so per node — never a silent mix.
 */
import { capacitySessionsOf } from '../auto-tune/recommend.js'
import type { NodeRecommendation } from '../auto-tune/plan-schemas.js'
import type {
  CapacityFallback,
  CapacitySource,
  SuggestedDeviceShare,
  SuggestedNodeShare,
  SuggestSharesResult,
} from './schemas.js'

/** One device's measured capacity (a node benchmark result, reduced to what shares need). */
export interface DeviceMeasuredCapacity {
  readonly deviceKey: string
  /** Parallel sessions the device sustained at the camera rate. */
  readonly maxSessions: number
  readonly modelId: string | null
  readonly measuredAtMs: number
  /**
   * Which measurement the number comes from: a `pipeline` cell's sessions, or
   * a `device` cell's `kMax` read as sessions (an upper bound — see
   * `sessionsOfDeviceCell`). Absent = a source that does not say.
   */
  readonly phase?: 'pipeline' | 'device'
}

/** One node's measured capacity. */
export interface NodeMeasuredCapacity {
  readonly nodeId: string
  readonly devices: readonly DeviceMeasuredCapacity[]
}

/**
 * Where measured node capacity is read from. The node-benchmark results
 * store implements it; until it exists the orchestrator wires one that
 * answers nothing, and every node falls back to `hardware`.
 */
export interface NodeCapacitySource {
  /** The usable (fresh) measured capacity of each asked node that has any. */
  readMeasuredCapacity(
    nodeIds: readonly string[],
  ): Promise<ReadonlyMap<string, NodeMeasuredCapacity>>
}

/**
 * The measured capacity of `deviceKey` for the model it runs NOW, or
 * undefined. A cell measured for another model says nothing about this one
 * (a failed load of a heavier build is not this build's capacity), and a cell
 * that names no model cannot be matched. The ONE predicate behind both the
 * automatic shares and the automatic benchmark's "has results".
 */
export function capacityForModel(
  node: NodeMeasuredCapacity | undefined,
  deviceKey: string,
  modelId: string | null,
): DeviceMeasuredCapacity | undefined {
  if (node === undefined || modelId === null) return undefined
  return node.devices
    .filter((d) => d.deviceKey === deviceKey && d.modelId === modelId)
    .toSorted((a, b) => b.measuredAtMs - a.measuredAtMs)[0]
}

/** A measured cell the shares ignore: it is for a model the device does not run now. */
export interface ForeignCapacityCell {
  readonly nodeId: string
  readonly deviceKey: string
  readonly measuredModelId: string
  /** The model Auto tune pins on the device now, or null = none chosen. */
  readonly runsModelId: string | null
}

/**
 * Every measured (device × model) cell that no device runs now — what
 * {@link capacityForModel} skips, so the caller can say so once.
 */
export function foreignCapacityCells(
  recommendations: readonly NodeRecommendation[],
  measured: ReadonlyMap<string, NodeMeasuredCapacity>,
): readonly ForeignCapacityCell[] {
  const out: ForeignCapacityCell[] = []
  for (const rec of recommendations) {
    const node = measured.get(rec.nodeId)
    if (node === undefined) continue
    for (const cell of node.devices) {
      const runs = rec.devices.find((d) => d.deviceKey === cell.deviceKey)?.chosen?.modelId ?? null
      if (cell.modelId === null || cell.modelId === runs) continue
      out.push({
        nodeId: rec.nodeId,
        deviceKey: cell.deviceKey,
        measuredModelId: cell.modelId,
        runsModelId: runs,
      })
    }
  }
  return out
}

/** A source that has no results — the benchmark store before it exists. */
export const NO_MEASURED_CAPACITY: NodeCapacitySource = {
  readMeasuredCapacity: async () => new Map(),
}

/** Integer shares summing to 100 (largest remainder); ties broken by key. */
export function toPercentShares(weights: ReadonlyMap<string, number>): Map<string, number> {
  const total = [...weights.values()].reduce((a, b) => a + b, 0)
  const out = new Map<string, number>()
  if (total <= 0) return out
  const raw = [...weights].map(([k, w]) => ({ k, exact: (w / total) * 100 }))
  let assigned = 0
  for (const r of raw) {
    out.set(r.k, Math.floor(r.exact))
    assigned += Math.floor(r.exact)
  }
  // Remainders equal up to float noise are a tie, broken by key.
  const remainder = (exact: number): number => Math.round((exact - Math.floor(exact)) * 1e6)
  const byRemainder = raw.toSorted(
    (a, b) => remainder(b.exact) - remainder(a.exact) || a.k.localeCompare(b.k),
  )
  for (let i = 0; i < 100 - assigned; i++) {
    const r = byRemainder[i % byRemainder.length]
    if (r === undefined) break
    out.set(r.k, (out.get(r.k) ?? 0) + 1)
  }
  return out
}

interface SizedDevice {
  readonly deviceKey: string
  readonly sessions: number
  /** What the device share inside its node follows. */
  readonly weight: number
  readonly modelId: string | null
  readonly fps: number | null
  readonly measured: boolean
}

interface SizedNode {
  readonly rec: NodeRecommendation
  readonly devices: readonly SizedDevice[]
  readonly capacitySource: CapacitySource | null
  readonly capacityFallback: CapacityFallback | null
  readonly skippedReason: string | null
}

function hardwareDevices(
  rec: NodeRecommendation,
  headroom: number,
  cameraFps: number,
): SizedDevice[] {
  return rec.devices
    .filter((d) => d.enabled && d.available && d.chosen !== null)
    .map((d) => {
      const fps = d.chosen?.fps ?? 0
      return {
        deviceKey: d.deviceKey,
        sessions: capacitySessionsOf(fps, headroom, cameraFps),
        weight: Math.max(fps, 0),
        modelId: d.chosen?.modelId ?? null,
        fps: d.chosen?.fps ?? null,
        measured: d.chosen?.measured ?? false,
      }
    })
}

function sizeNode(
  rec: NodeRecommendation,
  input: {
    readonly source: CapacitySource
    readonly measured: ReadonlyMap<string, NodeMeasuredCapacity>
    readonly headroom: number
    readonly cameraFps: number
  },
): SizedNode {
  const fromHardware = (fallback: CapacityFallback | null): SizedNode => {
    const devices = rec.skipped ? [] : hardwareDevices(rec, input.headroom, input.cameraFps)
    const capacity = devices.reduce((sum, d) => sum + d.sessions, 0)
    return {
      rec,
      devices,
      capacitySource: rec.skipped ? null : 'hardware',
      capacityFallback: rec.skipped ? null : fallback,
      skippedReason: rec.skipped
        ? (rec.reasons[0]?.kind ?? 'skipped')
        : capacity > 0
          ? null
          : 'no-capacity',
    }
  }
  if (input.source === 'hardware') return fromHardware(null)
  if (!rec.reachable) return fromHardware(null)

  const results = input.measured.get(rec.nodeId)
  // The row for a device is the one measured at the model Auto tune pins there.
  const byKey = new Map<string, DeviceMeasuredCapacity>()
  for (const d of rec.devices) {
    const row = capacityForModel(results, d.deviceKey, d.chosen?.modelId ?? null)
    if (row !== undefined) byKey.set(d.deviceKey, row)
  }
  const usable = rec.devices.filter((d) => d.enabled && d.available)
  // Every device hardware would size must be measured; otherwise the node is
  // one source or the other, never a mix.
  const mustCover = rec.devices.filter((d) => d.enabled && d.available && d.chosen !== null)
  const covered = usable.filter((d) => byKey.has(d.deviceKey))
  if (covered.length === 0) return fromHardware('no-benchmark-results')
  if (mustCover.some((d) => !byKey.has(d.deviceKey))) {
    return fromHardware('partial-benchmark-results')
  }
  const devices = covered.map((d): SizedDevice => {
    const row = byKey.get(d.deviceKey)
    const sessions = Math.max(0, Math.floor(row?.maxSessions ?? 0))
    return {
      deviceKey: d.deviceKey,
      sessions,
      weight: sessions,
      modelId: row?.modelId ?? null,
      fps: null,
      measured: true,
    }
  })
  const capacity = devices.reduce((sum, d) => sum + d.sessions, 0)
  return {
    rec,
    devices,
    capacitySource: 'benchmark',
    capacityFallback: null,
    skippedReason: capacity > 0 ? null : 'no-capacity',
  }
}

/** Shares proportional to capacity — the automatic shares and the suggestion are this. */
export function computeCapacityShares(input: {
  readonly recommendations: readonly NodeRecommendation[]
  readonly source: CapacitySource
  readonly measured: ReadonlyMap<string, NodeMeasuredCapacity>
  readonly headroom: number
  readonly cameraFps: number
  readonly minSessionsPerDevice: number
}): SuggestSharesResult {
  const sized = input.recommendations.map((rec) => sizeNode(rec, input))
  const capacityByNode = new Map<string, number>()
  for (const node of sized) {
    const capacity = node.devices.reduce((sum, d) => sum + d.sessions, 0)
    if (node.skippedReason === null && capacity > 0) capacityByNode.set(node.rec.nodeId, capacity)
  }
  const nodePct = toPercentShares(capacityByNode)
  const nodes = sized.map((node): SuggestedNodeShare => {
    const devicePct = toPercentShares(new Map(node.devices.map((d) => [d.deviceKey, d.weight])))
    return {
      nodeId: node.rec.nodeId,
      share: nodePct.get(node.rec.nodeId) ?? null,
      capacitySessions: node.devices.reduce((sum, d) => sum + d.sessions, 0),
      skippedReason: node.skippedReason,
      capacitySource: node.capacitySource,
      capacityFallback: node.capacityFallback,
      devices: node.devices.map(
        (d): SuggestedDeviceShare => ({
          deviceKey: d.deviceKey,
          share: devicePct.get(d.deviceKey) ?? 0,
          modelId: d.modelId,
          fps: d.fps,
          measured: d.measured,
          suggestedMaxSessions: d.sessions,
        }),
      ),
    }
  })
  return {
    headroom: input.headroom,
    source: input.source,
    cameraFps: input.cameraFps,
    minSessionsPerDevice: input.minSessionsPerDevice,
    nodes,
  }
}
