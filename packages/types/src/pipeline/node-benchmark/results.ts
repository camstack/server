/**
 * Which node benchmark result still beats the table (D791). Pure.
 *
 * A row is FRESH when it is the newest for its cell (node × device × phase
 * × model [× steps]), younger than the stale bound (30 days), and was
 * measured on the pool the node runs today (same runtime, same tuning). A
 * fresh row is what Auto tune and the automatic shares read; anything else
 * falls back to the latency table and says why.
 *
 * A pool the node does not answer for today does not make a row stale: an
 * unreadable fact is not a changed one.
 */
import type {
  DeviceMeasuredCapacity,
  NodeMeasuredCapacity,
} from '../load-balancing/capacity-shares.js'
import {
  NODE_BENCHMARK_DEFAULTS,
  type NodeBenchmarkResult,
  type NodeBenchmarkResultView,
} from './schemas.js'

/** The pool a device runs today, as `getEffectiveTuning` answers it. */
export interface CurrentPool {
  readonly runtime: string
  readonly numWorkers: number
  readonly concurrency: number
  readonly batchMode: string
}

export interface StandingContext {
  readonly nowMs: number
  /** Default {@link NODE_BENCHMARK_DEFAULTS.staleAfterDays}. */
  readonly staleAfterMs?: number
  /** nodeId → deviceKey → the pool now; a missing entry is "unknown", never "changed". */
  readonly currentPools: Readonly<Record<string, Readonly<Record<string, CurrentPool>>>>
}

export interface Standing {
  readonly standing: NodeBenchmarkResultView['standing']
  readonly staleWhy: NodeBenchmarkResultView['staleWhy']
}

/** The cell a row measures — two rows with the same key measure the same thing. */
export function resultCellKey(row: NodeBenchmarkResult): string {
  const { cell } = row
  const steps = cell.phase === 'pipeline' ? cell.steps.toSorted().join(',') : ''
  return [row.nodeId, cell.deviceKey, cell.phase, cell.modelId, steps].join('|')
}

function staleWhy(row: NodeBenchmarkResult, ctx: StandingContext): Standing['staleWhy'] {
  const bound = ctx.staleAfterMs ?? NODE_BENCHMARK_DEFAULTS.staleAfterDays * 86_400_000
  if (ctx.nowMs - row.measuredAtMs > bound) return 'age'
  const now = ctx.currentPools[row.nodeId]?.[row.cell.deviceKey]
  const then = row.fingerprint?.pools[row.cell.deviceKey]
  if (now === undefined || then === undefined) return null
  if (now.runtime !== then.runtime) return 'runtime'
  if (
    now.numWorkers !== then.numWorkers ||
    now.concurrency !== then.concurrency ||
    now.batchMode !== then.batchMode
  ) {
    return 'pool-tuning'
  }
  return null
}

/** The standing of every row, by id. */
export function resultStandings(
  rows: readonly NodeBenchmarkResult[],
  ctx: StandingContext,
): ReadonlyMap<string, Standing> {
  const newest = new Map<string, NodeBenchmarkResult>()
  for (const row of rows) {
    const key = resultCellKey(row)
    const held = newest.get(key)
    if (held === undefined || row.measuredAtMs > held.measuredAtMs) newest.set(key, row)
  }
  const out = new Map<string, Standing>()
  for (const row of rows) {
    if (newest.get(resultCellKey(row))?.id !== row.id) {
      out.set(row.id, { standing: 'superseded', staleWhy: null })
      continue
    }
    const why = staleWhy(row, ctx)
    out.set(
      row.id,
      why === null ? { standing: 'fresh', staleWhy: null } : { standing: 'stale', staleWhy: why },
    )
  }
  return out
}

/** Rows that beat the table today. */
export function freshResults(
  rows: readonly NodeBenchmarkResult[],
  ctx: StandingContext,
): readonly NodeBenchmarkResult[] {
  const standings = resultStandings(rows, ctx)
  return rows.filter((r) => standings.get(r.id)?.standing === 'fresh')
}

/** One measured detector on one device — what Auto tune overlays on the table. */
export interface MeasuredDetectorCell {
  readonly p50Ms: number
  readonly fps: number
  readonly resultId: string
  readonly measuredAtMs: number
}

/** deviceKey → modelId → the fresh `device` measurement on `nodeId`. */
export function measuredDetectorCells(
  rows: readonly NodeBenchmarkResult[],
  nodeId: string,
  ctx: StandingContext,
): Readonly<Record<string, Readonly<Record<string, MeasuredDetectorCell>>>> {
  const out: Record<string, Record<string, MeasuredDetectorCell>> = {}
  for (const row of freshResults(rows, ctx)) {
    if (row.nodeId !== nodeId || row.cell.phase !== 'device') continue
    const perDevice = out[row.cell.deviceKey] ?? {}
    perDevice[row.cell.modelId] = {
      p50Ms: Math.round(row.cell.p50Ms * 100) / 100,
      fps: row.cell.fps,
      resultId: row.id,
      measuredAtMs: row.measuredAtMs,
    }
    out[row.cell.deviceKey] = perDevice
  }
  return out
}

/**
 * Parallel sessions a `device`-phase cell stands for.
 *
 * Both numbers are "streams at the camera rate the hardware carried inside
 * the frame interval" (`kMax` for the detector alone, `maxSessions` for the
 * detector plus its enrichment steps) and the benchmark page already shows
 * `kMax` as "streams", so the unit is the same and the conversion is the
 * identity. It is an UPPER bound for a session that also runs enrichment —
 * which is why a `pipeline` cell for the same model always wins over it.
 */
export function sessionsOfDeviceCell(kMax: number): number {
  return Math.max(0, Math.floor(kMax))
}

/**
 * Per node, every (device × model) at its best fresh measurement: the newest
 * `pipeline` cell, else the newest `device` cell read as
 * {@link sessionsOfDeviceCell}. Several models of one device are kept apart —
 * the caller picks the one the device runs NOW (a cell for another model says
 * nothing about it).
 */
export function measuredCapacityFromResults(
  rows: readonly NodeBenchmarkResult[],
  nodeIds: readonly string[],
  ctx: StandingContext,
): ReadonlyMap<string, NodeMeasuredCapacity> {
  const byNode = new Map<string, Map<string, DeviceMeasuredCapacity>>()
  for (const row of freshResults(rows, ctx)) {
    if (!nodeIds.includes(row.nodeId)) continue
    const candidate = capacityOfRow(row)
    const devices = byNode.get(row.nodeId) ?? new Map<string, DeviceMeasuredCapacity>()
    const key = `${candidate.deviceKey}\u0000${candidate.modelId ?? ''}`
    const held = devices.get(key)
    if (held === undefined || betterCapacityCell(candidate, held)) devices.set(key, candidate)
    byNode.set(row.nodeId, devices)
  }
  const out = new Map<string, NodeMeasuredCapacity>()
  for (const nodeId of nodeIds) {
    const devices = byNode.get(nodeId)
    if (devices === undefined) continue
    out.set(nodeId, {
      nodeId,
      devices: [...devices.values()].toSorted(
        (a, b) =>
          a.deviceKey.localeCompare(b.deviceKey) ||
          (a.modelId ?? '').localeCompare(b.modelId ?? ''),
      ),
    })
  }
  return out
}

function capacityOfRow(row: NodeBenchmarkResult): DeviceMeasuredCapacity {
  const { cell } = row
  return cell.phase === 'pipeline'
    ? {
        deviceKey: cell.deviceKey,
        maxSessions: cell.maxSessions,
        modelId: cell.modelId,
        measuredAtMs: row.measuredAtMs,
        phase: 'pipeline',
      }
    : {
        deviceKey: cell.deviceKey,
        maxSessions: sessionsOfDeviceCell(cell.kMax),
        modelId: cell.modelId,
        measuredAtMs: row.measuredAtMs,
        phase: 'device',
      }
}

/** A pipeline cell beats a device cell; within a phase the newer one wins. */
function betterCapacityCell(a: DeviceMeasuredCapacity, b: DeviceMeasuredCapacity): boolean {
  if (a.phase !== b.phase) return a.phase === 'pipeline'
  return a.measuredAtMs > b.measuredAtMs
}
