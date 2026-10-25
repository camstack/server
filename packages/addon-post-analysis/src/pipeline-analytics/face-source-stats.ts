/**
 * Per-camera cost of keeping face source frames (D644), in RAM, since boot.
 *
 * The controller turns `keepSourceFrames` on only after measuring what it
 * costs, so the two numbers it asked for are here, per camera:
 *
 *  - **parks per track** — each park is one native JPEG encode on the runner;
 *  - **park ms** — the hub-measured round trip of the park order, which is the
 *    runner's encode plus one RPC (the runner does not report its encode time
 *    on the wire, and a new wire field would need a framework release).
 *
 * Plus what came of them: stored (parked / reused track keyFrame), bytes, and
 * every drop by reason. Bounded: one record per camera, one small counter per
 * LIVE track, a fixed window of park timings per camera.
 */

/** Park timings kept per camera for the percentiles. */
const PARK_MS_WINDOW = 256

/** What one camera has cost so far. */
export interface FaceSourceDeviceStats {
  readonly deviceId: number
  readonly parks: number
  readonly tracksParked: number
  readonly parksPerTrackMean: number
  readonly parksPerTrackMax: number
  readonly keyFrameReuses: number
  readonly parkMsP50: number | null
  readonly parkMsP95: number | null
  readonly parkMsMax: number | null
  readonly parkFailures: number
  readonly storedParked: number
  readonly storedTrackKeyFrame: number
  readonly storedBytes: number
  readonly dropped: Readonly<Record<string, number>>
}

interface DeviceRecord {
  parks: number
  tracksParked: number
  parksPerTrackMax: number
  keyFrameReuses: number
  parkMs: number[]
  parkFailures: number
  storedParked: number
  storedTrackKeyFrame: number
  storedBytes: number
  dropped: Map<string, number>
}

function emptyRecord(): DeviceRecord {
  return {
    parks: 0,
    tracksParked: 0,
    parksPerTrackMax: 0,
    keyFrameReuses: 0,
    parkMs: [],
    parkFailures: 0,
    storedParked: 0,
    storedTrackKeyFrame: 0,
    storedBytes: 0,
    dropped: new Map(),
  }
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx] ?? null
}

export class FaceSourceStats {
  private readonly devices = new Map<number, DeviceRecord>()
  /** Parks per LIVE track; folded into its camera at track end. */
  private readonly liveTracks = new Map<string, number>()

  private record(deviceId: number): DeviceRecord {
    let r = this.devices.get(deviceId)
    if (r === undefined) {
      r = emptyRecord()
      this.devices.set(deviceId, r)
    }
    return r
  }

  notePark(deviceId: number, trackId: string): void {
    const r = this.record(deviceId)
    r.parks += 1
    const n = (this.liveTracks.get(trackId) ?? 0) + 1
    if (n === 1) r.tracksParked += 1
    this.liveTracks.set(trackId, n)
    r.parksPerTrackMax = Math.max(r.parksPerTrackMax, n)
  }

  noteParkMs(deviceId: number, ms: number, parked: boolean): void {
    const r = this.record(deviceId)
    if (!parked) r.parkFailures += 1
    r.parkMs.push(ms)
    if (r.parkMs.length > PARK_MS_WINDOW) r.parkMs.shift()
  }

  noteKeyFrameReuse(deviceId: number): void {
    this.record(deviceId).keyFrameReuses += 1
  }

  noteStored(deviceId: number, mode: 'parked' | 'track-keyframe', bytes = 0): void {
    const r = this.record(deviceId)
    if (mode === 'parked') r.storedParked += 1
    else r.storedTrackKeyFrame += 1
    r.storedBytes += bytes
  }

  noteDropped(deviceId: number, reason: string): void {
    const r = this.record(deviceId)
    r.dropped.set(reason, (r.dropped.get(reason) ?? 0) + 1)
  }

  endTrack(_deviceId: number, trackId: string): void {
    this.liveTracks.delete(trackId)
  }

  snapshot(): readonly FaceSourceDeviceStats[] {
    return [...this.devices.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([deviceId, r]) => {
        const sorted = r.parkMs.toSorted((a, b) => a - b)
        return {
          deviceId,
          parks: r.parks,
          tracksParked: r.tracksParked,
          parksPerTrackMean: r.tracksParked === 0 ? 0 : r.parks / r.tracksParked,
          parksPerTrackMax: r.parksPerTrackMax,
          keyFrameReuses: r.keyFrameReuses,
          parkMsP50: percentile(sorted, 0.5),
          parkMsP95: percentile(sorted, 0.95),
          parkMsMax: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
          parkFailures: r.parkFailures,
          storedParked: r.storedParked,
          storedTrackKeyFrame: r.storedTrackKeyFrame,
          storedBytes: r.storedBytes,
          dropped: Object.fromEntries(r.dropped),
        }
      })
  }
}
