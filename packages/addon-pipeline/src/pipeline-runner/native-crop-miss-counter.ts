/**
 * Per-camera count of native crops the runner could not produce — the caller
 * asked for a native-resolution crop and was handed nothing (`miss` tier).
 *
 * Cumulative since the camera attached, and shipped as an additive field of the
 * camera metrics snapshot the orchestrator already receives; the consumer
 * derives per-interval deltas. One number per attached camera: bounded.
 */
export class NativeCropMissCounter {
  private readonly counts = new Map<number, number>()

  note(deviceId: number): void {
    this.counts.set(deviceId, (this.counts.get(deviceId) ?? 0) + 1)
  }

  /** Misses since attach; `0` for a camera that has not missed. */
  total(deviceId: number): number {
    return this.counts.get(deviceId) ?? 0
  }

  /** Forget a camera (detach): a re-attach starts from zero, which readers treat as a counter reset. */
  forget(deviceId: number): void {
    this.counts.delete(deviceId)
  }
}
