import { describe, it, expect } from 'vitest'
import { MotionWithoutInferenceDetector } from '../motion-without-inference.js'

/**
 * The 2026-07-30 incident, reproduced: device 101 had motion every ~5 s while
 * the inference path processed nothing, for 65 minutes. Nothing reported it.
 */
const MOTION_NO_INFERENCE = { motionFrames: 40, inferenceFrames: 0 }
const HEALTHY = { motionFrames: 40, inferenceFrames: 250 }

describe('MotionWithoutInferenceDetector', () => {
  it('stays quiet for a single bad interval — one slow report is not a stall', () => {
    const d = new MotionWithoutInferenceDetector()
    expect(d.observe(101, MOTION_NO_INFERENCE).kind).toBe('quiet')
    expect(d.observe(101, MOTION_NO_INFERENCE).kind).toBe('quiet')
  })

  it('speaks once the condition has held for the full streak', () => {
    const d = new MotionWithoutInferenceDetector(3)
    d.observe(101, MOTION_NO_INFERENCE)
    d.observe(101, MOTION_NO_INFERENCE)
    expect(d.observe(101, MOTION_NO_INFERENCE)).toEqual({ kind: 'stalled', intervals: 3 })
  })

  it('speaks ONCE, not every interval — a 65-minute outage is one line', () => {
    const d = new MotionWithoutInferenceDetector(3)
    const verdicts = Array.from({ length: 400 }, () => d.observe(101, MOTION_NO_INFERENCE).kind)
    expect(verdicts.filter((v) => v === 'stalled')).toHaveLength(1)
  })

  it('reports the recovery, so the log says how long it lasted', () => {
    const d = new MotionWithoutInferenceDetector(3)
    for (let i = 0; i < 10; i++) d.observe(101, MOTION_NO_INFERENCE)
    expect(d.observe(101, HEALTHY)).toEqual({ kind: 'recovered', intervals: 10 })
  })

  it('does not announce a recovery that was never a stall', () => {
    const d = new MotionWithoutInferenceDetector(3)
    d.observe(101, MOTION_NO_INFERENCE)
    expect(d.observe(101, HEALTHY).kind).toBe('quiet')
  })

  it('NEVER fires on a camera that is merely quiet — zero detections is normal', () => {
    const d = new MotionWithoutInferenceDetector(3)
    // Inference running, nothing to see: the common case, must stay silent.
    const verdicts = Array.from(
      { length: 50 },
      () => d.observe(101, { motionFrames: 40, inferenceFrames: 250 }).kind,
    )
    expect(new Set(verdicts)).toEqual(new Set(['quiet']))
  })

  it('says nothing about a camera with no motion at all', () => {
    const d = new MotionWithoutInferenceDetector(1)
    expect(d.observe(101, { motionFrames: 0, inferenceFrames: 0 }).kind).toBe('quiet')
  })

  it('treats a lull as part of ONE outage, not two', () => {
    const d = new MotionWithoutInferenceDetector(3)
    d.observe(101, MOTION_NO_INFERENCE)
    d.observe(101, MOTION_NO_INFERENCE)
    // A quiet interval with no motion — no evidence either way.
    expect(d.observe(101, { motionFrames: 0, inferenceFrames: 0 }).kind).toBe('quiet')
    // The next bad interval completes the streak rather than restarting it.
    expect(d.observe(101, MOTION_NO_INFERENCE)).toEqual({ kind: 'stalled', intervals: 3 })
  })

  it('tracks cameras independently — one stalled node does not implicate another', () => {
    const d = new MotionWithoutInferenceDetector(2)
    d.observe(101, MOTION_NO_INFERENCE)
    d.observe(102, HEALTHY)
    expect(d.observe(101, MOTION_NO_INFERENCE).kind).toBe('stalled')
    expect(d.observe(102, HEALTHY).kind).toBe('quiet')
    expect(d.stalledDevices()).toEqual([101])
  })

  it('forgets a detached camera rather than reporting a stale stall', () => {
    const d = new MotionWithoutInferenceDetector(2)
    d.observe(101, MOTION_NO_INFERENCE)
    d.observe(101, MOTION_NO_INFERENCE)
    expect(d.stalledDevices()).toEqual([101])
    d.forget(101)
    expect(d.stalledDevices()).toEqual([])
  })
})
