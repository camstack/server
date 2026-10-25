import { EventEmitter } from 'node:events'
import type { EngineOutput, IInferenceEngine, StepDefinition } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchPostprocess } from '../../postprocess/dispatch.js'

/**
 * A shed is flow control, NOT a failure.
 *
 * The Python pool (and the TS worker in-flight cap that mirrors it) answers
 * `{dropped: true}` when it deliberately skips a frame under overload. Until
 * 2026-08-01 that record rode through `PoolHandle` as `structured`, failed the
 * StepOutput kind guard in the postprocess funnel, and every single deliberate
 * shed was thrown + logged as `runInference failed … Python pool returned
 * structured output with unexpected kind: undefined` at ERROR level — ~4/s
 * across all three nodes, making the operator believe inference was failing
 * cluster-wide when it was shedding by design.
 *
 * These tests pin the two layers of the fix:
 *   1. SOURCE — `poolResultToEngineOutput` turns a shed record into a
 *      first-class `EngineOutput.dropped` with NO structured payload.
 *   2. FUNNEL — `dispatchPostprocess` never throws on a shed output; it
 *      returns an inert empty result instead of reaching a postprocessor.
 */

// The pool module spawns a Python child on construction — fake it, exactly as
// pool-in-flight-cap.spec.ts does, so the real end-to-end path (saturated
// worker → shed record → PoolHandle → EngineOutput) can be driven.
const spawned: FakeChild[] = []

class FakeChild extends EventEmitter {
  readonly stdin = { write: vi.fn(() => true) }
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly pid = 4243
  kill = vi.fn()
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const c = new FakeChild()
    spawned.push(c)
    return c
  },
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: () => true }
})

/** Bring up a pool with a faked Python child, answer its ready handshake, and
 *  return the model-slot engine handle production code uses. */
async function makeHandle(): Promise<IInferenceEngine> {
  const mod = await import('../shared-inference-pool.js')
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  const pool = new mod.SharedInferencePool('/usr/bin/python3', 'onnxruntime', log as never, {
    numWorkers: 1,
  })
  const init = pool.initialize([])
  const child = spawned[0]!
  const json = Buffer.from(JSON.stringify({ status: 'ready', models: [] }), 'utf8')
  const frame = Buffer.allocUnsafe(8 + json.length)
  frame.writeUInt32LE(4 + json.length, 0)
  frame.writeUInt32LE(0, 4)
  json.copy(frame, 8)
  child.stdout.emit('data', frame)
  await init
  return pool.getHandle(0)
}

const JPEG_INPUT = { kind: 'jpeg', data: Buffer.alloc(16) } as const

const YOLO_STEP_DEF: StepDefinition = {
  id: 'object-detection',
  name: 'Object detection',
  slot: 'detector',
  postprocessor: 'yolo',
  extractMode: 'full-frame',
  inputClasses: null,
  outputClasses: ['person'],
  models: [],
  defaultModelId: 'test-model',
  defaultConfidence: 0.5,
}

describe('overload shed is a first-class outcome, not a malformed result', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.stubEnv('CAMSTACK_POOL_MAX_IN_FLIGHT', '2')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('SOURCE: a saturated worker yields EngineOutput.dropped with NO structured payload', async () => {
    const engine = await makeHandle()

    // Fill the in-flight cap with requests the worker never answers…
    void engine.infer(JPEG_INPUT)
    void engine.infer(JPEG_INPUT)

    // …so the next one is shed. It must surface as `dropped`, never as a
    // `structured` record a postprocessor would choke on.
    const output = await engine.infer(JPEG_INPUT)
    expect(output.dropped).toBe(true)
    expect(output.shedReason).toBe('worker-in-flight-cap')
    expect(output.structured).toBeUndefined()
  })

  it('SOURCE: poolResultToEngineOutput passes a real result through as structured', async () => {
    const mod = await import('../shared-inference-pool.js')
    const real = mod.poolResultToEngineOutput({ kind: 'detections', detections: [] }, 12)
    expect(real.dropped).toBeUndefined()
    expect(real.structured).toEqual({ kind: 'detections', detections: [] })
    expect(real.inferenceMs).toBe(12)
  })

  it('FUNNEL: dispatchPostprocess never throws on a shed — it returns an inert empty output', () => {
    const shed: EngineOutput = { dropped: true, shedReason: 'worker-in-flight-cap', inferenceMs: 0 }
    // The exact defect: before the fix this path threw
    // "Python pool returned structured output with unexpected kind: undefined".
    expect(() => dispatchPostprocess(shed, YOLO_STEP_DEF)).not.toThrow()
    expect(dispatchPostprocess(shed, YOLO_STEP_DEF)).toEqual({ kind: 'detections', detections: [] })
  })

  it('END-TO-END: a shed pool response never reaches a postprocessor as an error', async () => {
    const engine = await makeHandle()
    void engine.infer(JPEG_INPUT)
    void engine.infer(JPEG_INPUT)

    const output = await engine.infer(JPEG_INPUT)
    // Feeding the shed engine output to the postprocess funnel must be safe.
    expect(() => dispatchPostprocess(output, YOLO_STEP_DEF)).not.toThrow()
  })
})
