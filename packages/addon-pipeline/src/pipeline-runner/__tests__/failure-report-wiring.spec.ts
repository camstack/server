/**
 * The inference-deadline counter, asserted through the REAL `PipelineRunner`
 * timeout path — a stalled `processFrame` and a fast one, on two cameras.
 *
 * The existing `runner-inference-stall.spec.ts` proves the LOG line fires. This
 * proves the number an operator reads: which camera timed out, and out of how
 * many calls. Disarmed and re-armed during review (D277 § Enforcement).
 */
import { describe, expect, it, vi } from 'vitest'
import type { DecodedFrame, FrameResult } from '@camstack/types'
import {
  FAMILY_INFERENCE,
  REASON_INFERENCE_TIMEOUT,
  RunnerFailureReport,
} from '../failure-report.js'
import { PipelineRunner } from '../runner.js'

function frame(_deviceId: number): DecodedFrame {
  return {
    width: 8,
    height: 8,
    format: 'rgb',
    data: Buffer.alloc(8 * 8 * 3),
    timestamp: Date.now(),
  }
}

/** A completed inference for a camera that answers at once. */
function answered(deviceId: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${deviceId}`,
    deviceId,
    timestamp: Date.now(),
    width: 8,
    height: 8,
    detections: [],
  }
}

function entry(
  report: RunnerFailureReport,
  deviceId: number,
): { attempts: number; succeeded: number; reasons: Record<string, number> } | undefined {
  const sample = report.list().find((s) => s.deviceId === deviceId && s.family === FAMILY_INFERENCE)
  if (sample === undefined) return undefined
  const reasons: Record<string, number> = {}
  for (const r of sample.reasons) reasons[r.reason] = r.count
  return { attempts: sample.attempts, succeeded: sample.succeeded, reasons }
}

describe('inference deadline counter', () => {
  it('counts a timeout against the stalled camera and a return as its denominator', async () => {
    vi.useFakeTimers()
    try {
      const report = new RunnerFailureReport()
      // 102 never answers; 101 answers immediately. The asymmetry is the point:
      // the operator's question is which camera, and a fleet total cannot say.
      const runner = new PipelineRunner({
        maxQueueDepth: 8,
        maxConcurrentInferences: 4,
        inferenceTimeoutMs: 20_000,
        // No throttle: an always-on camera admits every enqueued frame.
        targetLoadPercent: 100,
        minThrottledFps: 5,
        analyzeMotion: async () => {},
        processFrame: async (deviceId) =>
          deviceId === 102 ? new Promise(() => {}) : answered(deviceId),
        noteInferenceOutcome: (deviceId, reason) => report.noteInference(deviceId, reason),
      })
      runner.registerCamera(102, { detectionMode: 'always-on', fps: 5 })
      runner.registerCamera(101, { detectionMode: 'always-on', fps: 5 })

      runner.enqueueDetectionFrame(102, frame(102), undefined)
      runner.enqueueDetectionFrame(101, frame(101), undefined)
      runner.start()
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(21_000)
      runner.stop()

      expect(entry(report, 102)).toEqual({
        attempts: 1,
        succeeded: 0,
        reasons: { [REASON_INFERENCE_TIMEOUT]: 1 },
      })
      // The denominator moved for the camera that answered, and ONLY for it.
      const dev101 = entry(report, 101)
      expect(dev101?.succeeded).toBeGreaterThanOrEqual(1)
      expect(dev101?.reasons).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })

  it('never counts one timeout twice', async () => {
    vi.useFakeTimers()
    try {
      const report = new RunnerFailureReport()
      const runner = new PipelineRunner({
        maxQueueDepth: 8,
        maxConcurrentInferences: 4,
        inferenceTimeoutMs: 20_000,
        // No throttle: an always-on camera admits every enqueued frame.
        targetLoadPercent: 100,
        minThrottledFps: 5,
        analyzeMotion: async () => {},
        processFrame: async () => new Promise(() => {}),
        noteInferenceOutcome: (deviceId, reason) => report.noteInference(deviceId, reason),
      })
      runner.registerCamera(102, { detectionMode: 'always-on', fps: 5 })
      runner.enqueueDetectionFrame(102, frame(102), undefined)
      runner.start()
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(21_000)
      runner.stop()

      // The timeout branch falls through to the same `return outcome` the
      // success path uses. An unguarded denominator would count this call as
      // both a failure and a success and halve the published rate.
      const dev102 = entry(report, 102)
      expect(dev102?.attempts).toBe(1)
      expect(dev102?.succeeded).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
