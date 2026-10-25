/**
 * `buildFrameResult` — frame-level debug surface contract.
 *
 * P0-3: `FrameResult.debug.stepTimings` / `totalInferenceMs` / `engine`
 * MUST be populated on every frame, regardless of the trace verbosity
 * requested by the caller. Before the refactor the assembler gated the
 * whole `debug` field behind `input.debug === true` (verbose mode),
 * which meant runtime paths using `traceVerbosity: 'summary'` or
 * `'off'` never saw `stepTimings` — breaking the benchmark UI, the
 * runner's per-node timing sampler, and the e2e step-timings tests.
 *
 * These unit tests exercise `buildFrameResult` in isolation (no engine
 * needed) to lock the invariant: frame-level `debug` is always there.
 */
import { describe, it, expect } from 'vitest'
import { buildFrameResult, type MutableObjectDetection } from '../pipeline/result-assembler.js'
import type { FrameStepTiming } from '@camstack/types'

function makeFirstLevel(id: string): MutableObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.8,
    bbox: [10, 20, 110, 220],
    ownLabels: [],
    alternateLabels: {},
    stepLatencyMs: {},
    modelIds: {},
  }
}

function makeStepTimings(): FrameStepTiming[] {
  return [
    { source: 'object-detection', modelId: 'yolov9t', ms: 18, detectionCount: 3 },
    { source: 'face-detection', modelId: 'scrfd-2.5g', ms: 25, detectionCount: 1 },
  ]
}

describe('buildFrameResult — frame-level debug surface', () => {
  it('always populates frame.debug.stepTimings, even when input.debug === false', () => {
    const frame = buildFrameResult({
      deviceId: 1,
      width: 1280,
      height: 720,
      firstLevel: [makeFirstLevel('d1')],
      details: [],
      stepTimings: makeStepTimings(),
      totalMs: 43,
      engine: 'python+coreml',
      debug: false, // <-- non-verbose path: per-detection debug stays off
      timestamp: 1_700_000_000_000,
    })
    expect(frame.debug).toBeDefined()
    expect(frame.debug!.stepTimings).toHaveLength(2)
    expect(frame.debug!.stepTimings![0]!.source).toBe('object-detection')
    expect(frame.debug!.totalInferenceMs).toBe(43)
    expect(frame.debug!.engine).toBe('python+coreml')
  })

  it('still populates frame.debug when the step timings array is empty', () => {
    const frame = buildFrameResult({
      deviceId: 1,
      width: 640,
      height: 480,
      firstLevel: [],
      details: [],
      stepTimings: [],
      totalMs: 0,
      engine: 'python+coreml',
      debug: false,
      timestamp: 1_700_000_000_000,
    })
    // Even when the pipeline produced nothing, debug must still exist
    // with a non-undefined stepTimings array (may be empty) so the
    // runner timing sampler + benchmark UI don't crash on `.map(...)`.
    expect(frame.debug).toBeDefined()
    expect(Array.isArray(frame.debug!.stepTimings)).toBe(true)
    expect(frame.debug!.stepTimings).toHaveLength(0)
    expect(frame.debug!.totalInferenceMs).toBe(0)
  })

  it('populates frame.debug with stepTimings even in the verbose path', () => {
    const frame = buildFrameResult({
      deviceId: 1,
      width: 1280,
      height: 720,
      firstLevel: [makeFirstLevel('d1')],
      details: [],
      stepTimings: makeStepTimings(),
      totalMs: 50,
      engine: 'onnx+cpu',
      debug: true, // verbose path: per-detection debug turned ON
      timestamp: 1_700_000_000_000,
    })
    // Verbose mode keeps the invariant — frame.debug.stepTimings is the
    // same on both paths.
    expect(frame.debug).toBeDefined()
    expect(frame.debug!.stepTimings).toHaveLength(2)
    expect(frame.debug!.engine).toBe('onnx+cpu')
  })

  it('emits the deviceId / width / height / detections correctly regardless of debug flag', () => {
    const frame = buildFrameResult({
      deviceId: 42,
      width: 1920,
      height: 1080,
      firstLevel: [makeFirstLevel('d1'), makeFirstLevel('d2')],
      details: [],
      stepTimings: [],
      totalMs: 10,
      engine: 'python+coreml',
      debug: false,
      timestamp: 42,
    })
    expect(frame.kind).toBe('frame')
    expect(frame.deviceId).toBe(42)
    expect(frame.width).toBe(1920)
    expect(frame.height).toBe(1080)
    expect(frame.detections).toHaveLength(2)
    expect(frame.detections[0]!.id).toBe('d1')
  })
})
