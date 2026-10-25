/**
 * What `pipeline-runner` reports through `failure-contribution` — the inference
 * deadline, per camera, with the frames that made it as the denominator.
 *
 * ## The number that was never divided
 *
 * ~120 `inference timed out — permit released, result discarded` lines in six
 * hours across seven cameras, on 2026-08-28, never investigated. The line has
 * carried `tags: { deviceId }` for a while, so the count per camera was always
 * available; what was not available was the number to divide it by. 120
 * timeouts out of 120 000 admitted frames and 120 out of 1 200 are opposite
 * findings and produce identical log volume.
 *
 * So the counter takes BOTH outcomes of the same await, from the same place in
 * `awaitInferenceBounded`. A success counted anywhere else would eventually
 * drift from the failure and turn the ratio into fiction.
 *
 * ## Why there is no `variant` yet
 *
 * `failure-contribution` has a `variant` slot exactly so "which camera AND
 * which model" is one read, and the operator asked for it. The runner cannot
 * fill it honestly: `awaitInferenceBounded` wraps
 * `config.processFrame(deviceId, frameInput, executorHandle)`, which runs the
 * camera's WHOLE pipeline graph behind one deadline. Nothing at this seam knows
 * which step was still running when the 20 s expired — `CameraRegistration`
 * carries fps and mode, not models.
 *
 * Naming the step means the executor attributing the deadline to the step that
 * held it, and reporting THAT. Emitting a `variant` the runner guessed (the
 * camera's configured graph id, say) would be worse than leaving it absent: it
 * would look like an attribution and be a label. Absent, never invented — the
 * same rule `load-contribution` states for a measurement nobody made.
 */

import { FailureCounters } from '@camstack/types'
import type { FailureCounterSample } from '@camstack/types'

/** One bounded inference deadline per admitted detection frame. */
export const FAMILY_INFERENCE = 'inference'

/** The call did not return inside `inferenceTimeoutMs`. */
export const REASON_INFERENCE_TIMEOUT = 'timeout'

/**
 * The runner's `failure-contribution` counters.
 *
 * One instance per runner process, read (never drained) by the provider.
 */
export class RunnerFailureReport {
  private readonly counters: FailureCounters

  constructor(
    private readonly now: () => number = Date.now,
    counters: FailureCounters = new FailureCounters(),
  ) {
    this.counters = counters
  }

  /** One bounded inference call. `reason` absent = it returned in time. */
  noteInference(deviceId: number, reason?: string): void {
    this.counters.note(
      { deviceId, family: FAMILY_INFERENCE, ...(reason !== undefined ? { reason } : {}) },
      this.now(),
    )
  }

  /** The `failure-contribution` provider's payload. Reads, never resets. */
  list(): readonly FailureCounterSample[] {
    return this.counters.snapshot(this.now())
  }

  /** Addon disposal. */
  clear(): void {
    this.counters.clear()
  }
}
