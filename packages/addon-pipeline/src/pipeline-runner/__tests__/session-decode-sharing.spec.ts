import { describe, it, expect, beforeEach, vi } from 'vitest'
import PipelineRunnerAddon from '../index.js'
import type { DecodedFrame } from '@camstack/types'

interface FakeRunner {
  enqueueDetectionFrame: ReturnType<typeof vi.fn>
  enqueueMotionFrame: ReturnType<typeof vi.fn>
}

/**
 * Single documented type-boundary cast for white-box access to the addon's
 * private sharing internals — same convention as onboard-motion-analyzer.spec.
 */
interface SharingInternals {
  sharedMotionSinks: Map<number, { minIntervalMs: number; lastMotionEnqueueTs: number }>
  sharedSinkNow: () => number
  registerSharedMotionSink(deviceId: number, motionFps: number): () => void
  enqueueSharedDetectionFrame(deviceId: number, frame: DecodedFrame): void
  runner: FakeRunner
}

function asSharing(addon: PipelineRunnerAddon): SharingInternals {
  return addon as unknown as SharingInternals
}

function makeRgbFrame(timestamp: number): DecodedFrame {
  // 2x2 rgb so rgbFrameToGrayFrame has real pixels to reduce.
  return {
    data: Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
    width: 2,
    height: 2,
    format: 'rgb',
    timestamp,
  }
}

describe('session-decode P4 sharing', () => {
  let addon: PipelineRunnerAddon
  let runner: FakeRunner

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
    runner = { enqueueDetectionFrame: vi.fn(), enqueueMotionFrame: vi.fn() }
    asSharing(addon).runner = runner
  })

  it('enqueues ONLY detection when no shared-motion sink is registered', () => {
    const frame = makeRgbFrame(1)
    asSharing(addon).enqueueSharedDetectionFrame(7, frame)

    expect(runner.enqueueDetectionFrame).toHaveBeenCalledTimes(1)
    expect(runner.enqueueDetectionFrame).toHaveBeenCalledWith(7, frame, undefined)
    expect(runner.enqueueMotionFrame).not.toHaveBeenCalled()
  })

  it('also enqueues a derived GRAY motion frame when the device has a sink', () => {
    const release = asSharing(addon).registerSharedMotionSink(7, 4)
    const frame = makeRgbFrame(2)
    asSharing(addon).enqueueSharedDetectionFrame(7, frame)

    expect(runner.enqueueDetectionFrame).toHaveBeenCalledWith(7, frame, undefined)
    expect(runner.enqueueMotionFrame).toHaveBeenCalledTimes(1)
    const [devId, motionFrame, handle] = runner.enqueueMotionFrame.mock.calls[0]!
    expect(devId).toBe(7)
    expect(handle).toBeUndefined()
    // Derived gray: one byte per pixel (2x2 → 4 bytes), not the rgb frame.
    expect(motionFrame.format).toBe('gray')
    expect(motionFrame.data.length).toBe(4)
    expect(motionFrame).not.toBe(frame)

    // A different device without a sink still gets detection-only.
    asSharing(addon).enqueueSharedDetectionFrame(8, frame)
    expect(runner.enqueueMotionFrame).toHaveBeenCalledTimes(1)

    release()
  })

  it('registerSharedMotionSink toggles set membership and the teardown is idempotent', () => {
    const sinks = asSharing(addon).sharedMotionSinks
    expect(sinks.has(7)).toBe(false)

    const release = asSharing(addon).registerSharedMotionSink(7, 4)
    expect(sinks.has(7)).toBe(true)

    release()
    expect(sinks.has(7)).toBe(false)
    release() // idempotent — no throw, still absent
    expect(sinks.has(7)).toBe(false)
  })

  it('a released sink stops the motion fan-out', () => {
    const release = asSharing(addon).registerSharedMotionSink(7, 4)
    release()
    asSharing(addon).enqueueSharedDetectionFrame(7, makeRgbFrame(3))
    expect(runner.enqueueMotionFrame).not.toHaveBeenCalled()
  })

  it('throttles shared motion enqueues to motionFps — detection stays per-frame (P4 regression)', () => {
    // The detection worker decodes ~22fps; the analyzer must see frames at
    // motionFps (4fps → 250ms apart) or inter-frame deltas collapse below the
    // wasm thresholds and NO regions are ever emitted (the missing
    // motion-boxes bug on onboard-driven cameras).
    let now = 10_000
    asSharing(addon).sharedSinkNow = () => now
    asSharing(addon).registerSharedMotionSink(7, 4)

    // 10 frames 44ms apart (~22fps) = 396ms window → exactly 2 motion
    // enqueues (t=0 and the first frame ≥250ms later), 10 detection enqueues.
    for (let i = 0; i < 10; i++) {
      asSharing(addon).enqueueSharedDetectionFrame(7, makeRgbFrame(i))
      now += 44
    }
    expect(runner.enqueueDetectionFrame).toHaveBeenCalledTimes(10)
    expect(runner.enqueueMotionFrame).toHaveBeenCalledTimes(2)
  })

  it('a non-positive motionFps falls back to a sane default instead of disabling motion', () => {
    let now = 0
    asSharing(addon).sharedSinkNow = () => now
    asSharing(addon).registerSharedMotionSink(7, 0)
    asSharing(addon).enqueueSharedDetectionFrame(7, makeRgbFrame(0))
    now += 1_000
    asSharing(addon).enqueueSharedDetectionFrame(7, makeRgbFrame(1))
    expect(runner.enqueueMotionFrame).toHaveBeenCalledTimes(2)
  })
})
