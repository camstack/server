/**
 * Storage-location occupancy over time, through device-history (D850).
 *
 * The figures are the ones `listLocations` already serves, from their own
 * authorities — nothing is measured twice:
 *  - the VOLUME (`location-used-percent`, `location-free-bytes`) from the same
 *    statfs probe the UI's capacity reads (`readLocalVolumeCapacity`), which
 *    answers only for a location THIS node can measure;
 *  - what CamStack HOLDS there (`location-owned-bytes`) from the
 *    `storage-occupancy` slice (D388).
 *
 * A figure that is unknown is NO point, never 0 (D393, D315): a failed statfs,
 * a remote provider, a location nobody reports owned bytes for.
 *
 * Subject: the node the location lives on (`nodeId`), else the node that
 * measured it. Scope: the location id, so a location keeps one series for life.
 */
import type { DeviceHistoryIngestResult, IScopedLogger } from '@camstack/types'

export const LOCATION_HISTORY_NAMES = {
  usedPercent: 'location-used-percent',
  freeBytes: 'location-free-bytes',
  ownedBytes: 'location-owned-bytes',
} as const

/** One location's sweep reading. */
export interface LocationReading {
  readonly locationId: string
  readonly nodeId: string
  /** `null` when this node cannot take a measurement that is about the location. */
  readonly capacity: { readonly totalBytes: number; readonly availableBytes: number } | null
  /** `undefined` when no provider reports what CamStack holds there. */
  readonly ownedBytes: number | undefined
}

export interface LocationHistoryPoint {
  readonly key: string
  readonly subject: { readonly kind: 'node'; readonly nodeId: string }
  readonly scope: string
  readonly ts: number
  readonly value: number
}

export interface LocationHistoryClient {
  declareSeries(input: {
    name: string
    subjectKind: 'node'
    kind: 'gauge'
    displayName: string
    ingest: 'points'
    unit: string
  }): Promise<{ key: string }>
  record(input: { points: readonly LocationHistoryPoint[] }): Promise<DeviceHistoryIngestResult>
}

export interface LocationHistoryRecorderDeps {
  readonly deviceHistory: LocationHistoryClient
  readonly logger: IScopedLogger
}

/** One reading per location per this many ms at most (the sweep runs every minute). */
export const LOCATION_HISTORY_MIN_INTERVAL_MS = 60_000

const DECLARATIONS = [
  { name: LOCATION_HISTORY_NAMES.usedPercent, displayName: 'Location volume used %', unit: '%' },
  { name: LOCATION_HISTORY_NAMES.freeBytes, displayName: 'Location volume free', unit: 'bytes' },
  {
    name: LOCATION_HISTORY_NAMES.ownedBytes,
    displayName: 'Location held by CamStack',
    unit: 'bytes',
  },
] as const

export class LocationHistoryRecorder {
  private readonly keys = new Map<string, string>()
  private readonly lastAt = new Map<string, number>()

  constructor(private readonly deps: LocationHistoryRecorderDeps) {}

  private async ensureDeclared(): Promise<boolean> {
    if (this.keys.size === DECLARATIONS.length) return true
    try {
      for (const d of DECLARATIONS) {
        const { key } = await this.deps.deviceHistory.declareSeries({
          name: d.name,
          subjectKind: 'node',
          kind: 'gauge',
          displayName: d.displayName,
          ingest: 'points',
          unit: d.unit,
        })
        this.keys.set(d.name, key)
      }
      return true
    } catch (err) {
      this.keys.clear()
      this.deps.logger.warn('storage: location history declare failed — retried next sweep', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return false
    }
  }

  /** The points of one sweep; pure apart from the per-location rate memory. */
  pointsOf(readings: readonly LocationReading[], at: number): readonly LocationHistoryPoint[] {
    const points: LocationHistoryPoint[] = []
    for (const r of readings) {
      const last = this.lastAt.get(r.locationId)
      if (last !== undefined && at >= last && at - last < LOCATION_HISTORY_MIN_INTERVAL_MS) continue
      const add = (name: string, value: number): void => {
        const key = this.keys.get(name)
        if (key === undefined || !Number.isFinite(value)) return
        points.push({
          key,
          subject: { kind: 'node', nodeId: r.nodeId },
          scope: r.locationId,
          ts: at,
          value,
        })
      }
      const before = points.length
      if (r.capacity !== null && r.capacity.totalBytes > 0) {
        const used = r.capacity.totalBytes - r.capacity.availableBytes
        add(
          LOCATION_HISTORY_NAMES.usedPercent,
          Math.round((used / r.capacity.totalBytes) * 1000) / 10,
        )
        add(LOCATION_HISTORY_NAMES.freeBytes, r.capacity.availableBytes)
      }
      if (r.ownedBytes !== undefined) add(LOCATION_HISTORY_NAMES.ownedBytes, r.ownedBytes)
      if (points.length > before) this.lastAt.set(r.locationId, at)
    }
    return points
  }

  async record(readings: readonly LocationReading[], at: number): Promise<void> {
    if (readings.length === 0 || !(await this.ensureDeclared())) return
    const points = this.pointsOf(readings, at)
    if (points.length === 0) return
    try {
      const result = await this.deps.deviceHistory.record({ points })
      if (result.refused.length > 0) {
        if (result.refused.some((r) => r.reason === 'undeclared')) this.keys.clear()
        this.deps.logger.warn('storage: location history points refused', {
          meta: { accepted: result.accepted, refused: result.refused },
        })
      }
    } catch (err) {
      this.deps.logger.warn('storage: location history not stored', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
