/**
 * SensorEventStore — per-camera history of LINKED-device sensor state
 * changes (Part B). One row per (camera, source-device state change): a
 * sensor linked to N cameras yields N rows so per-camera timeline queries
 * stay a single indexed range scan, mirroring the motion/object/audio
 * event collections in `event-store.ts`.
 *
 * Collection: `pipeline-analytics:sensor-events`, declared once in
 * onInitialize via `declareCollection` with a (deviceId, timestamp) index.
 *
 * Ingest is telemetry-lossy by design (D8): rows are inserted from
 * `EventCategory.DeviceStateChanged` bus events — a dropped event is a
 * missing history row, never wrong durable state.
 */
import type { IScopedLogger, SensorEvent } from '@camstack/types'
import type { EventLedgerCollection } from './event-ledger-collection.js'

/**
 * @durable class=ledger owner=pipeline-analytics database=events
 *   write="one row per (watching camera, linked-sensor state change) — a sensor
 *     linked to N cameras writes N rows, so a per-camera timeline stays one indexed
 *     range scan. Ingest is telemetry-lossy by design (D8): the insert is
 *     best-effort off DeviceStateChanged, and a dropped bus event costs a history
 *     row, never durable state."
 *   retention="a TERMINAL age-keyed root — no trackId, owns nothing, nothing
 *     references it. evictBefore(deviceId, cutoff) runs in the same trackless sweep
 *     as motion and audio, on the CAMERA's one retention window. It used to sweep
 *     the whole table on the fleet MINIMUM cutoff because the store had no device
 *     scope (D61)."
 */
export const SENSOR_EVENTS_COLLECTION = 'pipeline-analytics:sensor-events'

export const SENSOR_EVENT_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  /** The CAMERA the event is attributed to. */
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  /** The linked sensor device whose state changed. */
  { name: 'sourceDeviceId', type: 'INTEGER' as const, notNull: true },
  /** Event kind id (matches an `EventKindDescriptor.kind`). */
  { name: 'kind', type: 'TEXT' as const, notNull: true },
  /** Snapshot of the sensor cap's runtime-state slice at the change. */
  { name: 'value', type: 'JSON' as const },
  { name: 'timestamp', type: 'INTEGER' as const, notNull: true },
] as const

export interface SensorEventStoreDeps {
  readonly logger: IScopedLogger
  readonly sensorLedger: EventLedgerCollection
}

export interface SensorEventQuery {
  readonly deviceId: number
  readonly since?: number
  readonly until?: number
  readonly kinds?: readonly string[]
  readonly limit?: number
}

const DEFAULT_QUERY_LIMIT = 1000

export class SensorEventStore {
  private readonly logger: IScopedLogger
  private readonly ledger: EventLedgerCollection

  constructor(deps: SensorEventStoreDeps) {
    this.logger = deps.logger
    this.ledger = deps.sensorLedger
  }

  /** Insert one attributed sensor event. Best-effort (telemetry-lossy). */
  async insert(ev: SensorEvent): Promise<void> {
    try {
      await this.ledger.insert({
        id: ev.id,
        deviceId: ev.deviceId,
        sourceDeviceId: ev.sourceDeviceId,
        kind: ev.kind,
        value: ev.value,
        timestamp: ev.timestamp,
      })
    } catch (err) {
      this.logger.warn('SensorEventStore.insert failed', {
        tags: { deviceId: ev.deviceId },
        meta: { eventId: ev.id, error: String(err) },
      })
    }
  }

  /** Per-camera sensor-event history, newest first. Mirrors the
   *  motion/object/audio query semantics; `kinds` narrows via `whereIn`. */
  async query(q: SensorEventQuery): Promise<readonly SensorEvent[]> {
    const filter: Record<string, unknown> = {
      where: { deviceId: q.deviceId },
      orderBy: { field: 'timestamp', direction: 'desc' },
      limit: q.limit ?? DEFAULT_QUERY_LIMIT,
    }
    if (q.since !== undefined || q.until !== undefined) {
      filter['whereBetween'] = { timestamp: [q.since ?? 0, q.until ?? Date.now()] }
    }
    if (q.kinds !== undefined && q.kinds.length > 0) {
      filter['whereIn'] = { kind: [...q.kinds] }
    }
    const rows = await this.ledger.query(filter)
    return rows.map((r) => rowToSensorEvent(r.id, r.data))
  }

  /**
   * Delete every row for ONE device with `timestamp ≤ cutoffMs`, draining a
   * page at a time (mirrors `EventStore.evictTracklessBefore`, including the
   * infinite-loop guard). Returns the number of rows deleted.
   *
   * A sensor event is a TERMINAL retention root: it carries no `trackId`, owns
   * no media and nothing references it, so its clock cannot contradict anyone
   * else's (`retention/retention-model.ts`).
   *
   * `deviceId` is REQUIRED now. This used to sweep the whole table on the fleet
   * MINIMUM cutoff — the loosest window any camera had — purely because the
   * store predated a device scope. It has an indexed `deviceId` column, so it
   * follows its camera's window like everything else (D61), which also turns a
   * full scan per page into an index seek.
   */
  async evictBefore(deviceId: number, cutoffMs: number): Promise<number> {
    const ids = await this.ledger.drainMatching({
      where: { deviceId },
      whereBetween: { timestamp: [0, cutoffMs] },
    })
    return ids.length
  }
}

function rowToSensorEvent(id: string, data: Record<string, unknown>): SensorEvent {
  const value = data['value']
  return {
    id,
    deviceId: Number(data['deviceId']),
    sourceDeviceId: Number(data['sourceDeviceId']),
    kind: String(data['kind']),
    value: isRecord(value) ? value : null,
    timestamp: Number(data['timestamp']),
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}
