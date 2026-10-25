/**
 * One ops-log row per retention SWEEP, not one per device per tick (D871).
 *
 * The retention pass used to append a `prune` row for every device that lost
 * anything, twice (the track cascade and the trackless roots), on every
 * five-minute tick: 4.5 k rows a day on a 36-camera hub, each saying a few
 * rows were removed. The audit's job is "what did retention do"; one row per
 * pass carrying the per-device counts answers that, and the 30 day clock that
 * trims the log stays the only retention it has.
 *
 * The row is a cluster-level one (`deviceId: null`); the per-device numbers
 * ride in `detail` as JSON, so nothing is lost, only grouped.
 */
import type { OpsLogReason } from '@camstack/types'
import type { EventsOpsLogAppendInput } from '../store/ops-log-store.js'

/** What one device lost in one pass. Every field is a count of rows. */
export interface DeviceSweepCounts {
  readonly tracks: number
  readonly trackEvents: number
  readonly media: number
  readonly faces: number
  readonly plates: number
  readonly embeddings: number
  readonly motion: number
  readonly audio: number
  readonly sensor: number
}

const COUNT_KEYS = [
  'tracks',
  'trackEvents',
  'media',
  'faces',
  'plates',
  'embeddings',
  'motion',
  'audio',
  'sensor',
] as const satisfies readonly (keyof DeviceSweepCounts)[]

const ZERO: DeviceSweepCounts = {
  tracks: 0,
  trackEvents: 0,
  media: 0,
  faces: 0,
  plates: 0,
  embeddings: 0,
  motion: 0,
  audio: 0,
  sensor: 0,
}

/** The JSON a sweep row carries in `detail`. */
export interface SweepSummaryDetail {
  readonly sweep: 'retention'
  readonly devices: Readonly<Record<string, Partial<DeviceSweepCounts>>>
}

/** Collects one pass's per-device counts, then builds the single row. */
export class RetentionSweepSummary {
  private readonly perDevice = new Map<number, DeviceSweepCounts>()
  private bytesReclaimed = 0

  /** Merge counts for a device (a device appears in both halves of the pass). */
  add(deviceId: number, counts: Partial<DeviceSweepCounts>): void {
    const held = this.perDevice.get(deviceId) ?? ZERO
    const merged: DeviceSweepCounts = {
      tracks: held.tracks + (counts.tracks ?? 0),
      trackEvents: held.trackEvents + (counts.trackEvents ?? 0),
      media: held.media + (counts.media ?? 0),
      faces: held.faces + (counts.faces ?? 0),
      plates: held.plates + (counts.plates ?? 0),
      embeddings: held.embeddings + (counts.embeddings ?? 0),
      motion: held.motion + (counts.motion ?? 0),
      audio: held.audio + (counts.audio ?? 0),
      sensor: held.sensor + (counts.sensor ?? 0),
    }
    this.perDevice.set(deviceId, merged)
  }

  addBytes(bytes: number): void {
    this.bytesReclaimed += bytes
  }

  /** The single row for the pass, or `null` when nothing was removed. */
  build(reason: OpsLogReason = 'retention'): EventsOpsLogAppendInput | null {
    const devices: Record<string, Partial<DeviceSweepCounts>> = {}
    let items = 0
    for (const [deviceId, counts] of this.perDevice) {
      const nonZero: Partial<Record<keyof DeviceSweepCounts, number>> = {}
      let total = 0
      for (const key of COUNT_KEYS) {
        if (counts[key] > 0) nonZero[key] = counts[key]
        total += counts[key]
      }
      if (total === 0) continue
      devices[String(deviceId)] = nonZero
      items += total
    }
    if (items === 0) return null
    const detail: SweepSummaryDetail = { sweep: 'retention', devices }
    return {
      op: 'prune',
      reason,
      deviceId: null,
      itemsAffected: items,
      bytesReclaimed: this.bytesReclaimed,
      detail: JSON.stringify(detail),
    }
  }
}
