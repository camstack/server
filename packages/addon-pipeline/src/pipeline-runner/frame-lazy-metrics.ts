/**
 * Bounded frame-lazy telemetry. Node counters plus a camera map pruned to the
 * currently attached set — never per-frame keys, never unbounded cardinality.
 */

export interface FrameLazyCounters {
  framesDecoded: number
  framesAdmitted: number
  framesDroppedPixelFree: number
  viewsMaterialized: number
  viewsSkipped: number
  workerToRunnerBytes: number
  runnerToPoolRawBytes: number
  runnerToPoolJpegBytes: number
  onDemandFullFrameRequests: number
  onDemandCropRequests: number
  nativeHits: number
  nativeMisses: number
  tileHits: number
  tileMisses: number
  fallbackHits: number
  fallbackMisses: number
  retainedWritesAvoided: number
  residentRefs: number
  residentBytes: number
  releases: number
  evictions: number
  staleMisses: number
}

export interface FrameLazySnapshot {
  readonly node: FrameLazyCounters
  readonly cameras: ReadonlyArray<{ readonly deviceId: number } & FrameLazyCounters>
}

export type FrameLazyHitKind = 'native' | 'tile' | 'fallback'

export function emptyFrameLazyCounters(): FrameLazyCounters {
  return {
    framesDecoded: 0,
    framesAdmitted: 0,
    framesDroppedPixelFree: 0,
    viewsMaterialized: 0,
    viewsSkipped: 0,
    workerToRunnerBytes: 0,
    runnerToPoolRawBytes: 0,
    runnerToPoolJpegBytes: 0,
    onDemandFullFrameRequests: 0,
    onDemandCropRequests: 0,
    nativeHits: 0,
    nativeMisses: 0,
    tileHits: 0,
    tileMisses: 0,
    fallbackHits: 0,
    fallbackMisses: 0,
    retainedWritesAvoided: 0,
    residentRefs: 0,
    residentBytes: 0,
    releases: 0,
    evictions: 0,
    staleMisses: 0,
  }
}

export class FrameLazyTelemetry {
  private readonly node = emptyFrameLazyCounters()
  private readonly cameras = new Map<number, FrameLazyCounters>()

  noteDecoded(deviceId: number): void {
    this.node.framesDecoded += 1
    this.camera(deviceId).framesDecoded += 1
  }

  noteAdmitted(deviceId: number): void {
    this.node.framesAdmitted += 1
    this.camera(deviceId).framesAdmitted += 1
  }

  noteDroppedPixelFree(deviceId: number): void {
    this.node.framesDroppedPixelFree += 1
    this.camera(deviceId).framesDroppedPixelFree += 1
  }

  noteView(input: {
    readonly deviceId: number
    readonly materialized: boolean
    readonly workerToRunnerBytes: number
  }): void {
    if (input.materialized) {
      this.node.viewsMaterialized += 1
      this.camera(input.deviceId).viewsMaterialized += 1
    } else {
      this.node.viewsSkipped += 1
      this.camera(input.deviceId).viewsSkipped += 1
    }
    this.node.workerToRunnerBytes += input.workerToRunnerBytes
    this.camera(input.deviceId).workerToRunnerBytes += input.workerToRunnerBytes
  }

  notePoolBytes(input: {
    readonly deviceId: number
    readonly raw: number
    readonly jpeg: number
  }): void {
    this.node.runnerToPoolRawBytes += input.raw
    this.node.runnerToPoolJpegBytes += input.jpeg
    this.camera(input.deviceId).runnerToPoolRawBytes += input.raw
    this.camera(input.deviceId).runnerToPoolJpegBytes += input.jpeg
  }

  noteOnDemandRequest(input: {
    readonly deviceId: number
    readonly kind: 'full-frame' | 'crop'
  }): void {
    if (input.kind === 'full-frame') {
      this.node.onDemandFullFrameRequests += 1
      this.camera(input.deviceId).onDemandFullFrameRequests += 1
    } else {
      this.node.onDemandCropRequests += 1
      this.camera(input.deviceId).onDemandCropRequests += 1
    }
  }

  noteHit(kind: FrameLazyHitKind, deviceId: number): void {
    this.addHit(this.node, kind, 1)
    this.addHit(this.camera(deviceId), kind, 1)
  }

  noteMiss(kind: FrameLazyHitKind, deviceId: number): void {
    this.addMiss(this.node, kind, 1)
    this.addMiss(this.camera(deviceId), kind, 1)
  }

  noteAvoidedWrite(deviceId: number): void {
    this.node.retainedWritesAvoided += 1
    this.camera(deviceId).retainedWritesAvoided += 1
  }

  noteRelease(deviceId?: number): void {
    this.node.releases += 1
    if (deviceId !== undefined) this.camera(deviceId).releases += 1
  }

  noteEviction(deviceId?: number): void {
    this.node.evictions += 1
    if (deviceId !== undefined) this.camera(deviceId).evictions += 1
  }

  noteStale(deviceId?: number): void {
    this.node.staleMisses += 1
    if (deviceId !== undefined) this.camera(deviceId).staleMisses += 1
  }

  /**
   * Node occupancy. `residentRefs` is entry count (pending + store), not
   * outstanding registry leases.
   */
  setResident(input: { readonly refs: number; readonly bytes: number }): void {
    this.node.residentRefs = input.refs
    this.node.residentBytes = input.bytes
  }

  setCameraResident(
    deviceId: number,
    input: { readonly refs: number; readonly bytes: number },
  ): void {
    const counters = this.camera(deviceId)
    counters.residentRefs = input.refs
    counters.residentBytes = input.bytes
  }

  forgetCamera(deviceId: number): void {
    this.cameras.delete(deviceId)
  }

  /**
   * Zero occupancy for already-tracked cameras absent from `present`.
   * Does not create or delete entries — snapshot still does not prune,
   * and detach still goes through {@link forgetCamera}.
   */
  zeroAbsentResidents(present: ReadonlySet<number>): void {
    for (const [deviceId, counters] of this.cameras) {
      if (present.has(deviceId)) continue
      counters.residentRefs = 0
      counters.residentBytes = 0
    }
  }

  snapshot(deviceIds: readonly number[]): FrameLazySnapshot {
    return {
      node: { ...this.node },
      cameras: deviceIds.map((deviceId) => ({
        deviceId,
        ...this.camera(deviceId),
      })),
    }
  }

  trackedCameraCount(): number {
    return this.cameras.size
  }

  private camera(deviceId: number): FrameLazyCounters {
    const existing = this.cameras.get(deviceId)
    if (existing) return existing
    const created = emptyFrameLazyCounters()
    this.cameras.set(deviceId, created)
    return created
  }

  private addHit(counters: FrameLazyCounters, kind: FrameLazyHitKind, n: number): void {
    if (kind === 'native') counters.nativeHits += n
    else if (kind === 'tile') counters.tileHits += n
    else counters.fallbackHits += n
  }

  private addMiss(counters: FrameLazyCounters, kind: FrameLazyHitKind, n: number): void {
    if (kind === 'native') counters.nativeMisses += n
    else if (kind === 'tile') counters.tileMisses += n
    else counters.fallbackMisses += n
  }
}
