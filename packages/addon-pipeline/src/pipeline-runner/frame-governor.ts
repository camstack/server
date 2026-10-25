/**
 * Adaptive per-camera inference admission — implements the previously-dead
 * `targetLoadPercent` / `minThrottledFps` knobs (spec:
 * docs/superpowers/specs/2026-07-14-two-plane-pipeline-design.md §1).
 *
 * Node budget = targetLoadPercent × (maxConcurrentInferences × 1000 ms/s),
 * split evenly across cameras with samples. Per-camera target fps =
 * clamp(share / avgInferenceMs, minThrottledFps, configuredFps || decodeFps).
 * Pure logic — the Runner feeds samples every recompute tick and reads
 * minIntervalMs at frame admission.
 */
export interface CameraLoadSample {
  readonly avgInferenceMs: number
  /** Operator-configured detectionFps; 0 = uncapped (bound by decode rate). */
  readonly configuredFps: number
  readonly decodeFps: number
}

export interface FrameGovernorConfig {
  readonly targetLoadPercent: number
  readonly minThrottledFps: number
  readonly maxConcurrentInferences: number
}

export class FrameGovernor {
  private readonly intervals = new Map<number, number>()
  private throttled = 0

  constructor(private readonly config: FrameGovernorConfig) {}

  update(samples: ReadonlyMap<number, CameraLoadSample>): void {
    this.intervals.clear()
    this.throttled = 0
    if (samples.size === 0) return
    const budgetMsPerSec =
      (this.config.targetLoadPercent / 100) * this.config.maxConcurrentInferences * 1000
    const shareMsPerSec = budgetMsPerSec / samples.size
    for (const [deviceId, s] of samples) {
      const ceilingFps = s.configuredFps > 0 ? s.configuredFps : s.decodeFps
      const affordableFps = s.avgInferenceMs > 0 ? shareMsPerSec / s.avgInferenceMs : ceilingFps
      const targetFps = Math.min(ceilingFps, Math.max(this.config.minThrottledFps, affordableFps))
      if (targetFps < ceilingFps) this.throttled++
      this.intervals.set(deviceId, targetFps > 0 ? 1000 / targetFps : 0)
    }
  }

  /** Minimum ms between admitted frames; 0 = no gate. */
  minIntervalMs(deviceId: number): number {
    return this.intervals.get(deviceId) ?? 0
  }

  throttledCount(): number {
    return this.throttled
  }
}
