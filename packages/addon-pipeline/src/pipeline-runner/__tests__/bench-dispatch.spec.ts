/**
 * Synthetic-bench dispatch shape.
 *
 * Two properties these tests exist to hold:
 *
 * 1. **A device-scoped bench never takes the cached fast path.** The fast
 *    path runs `cacheFrameInPool` + `inferCached`, and NEITHER cap method
 *    has a `deviceKey` — only `runPipeline` does. Forwarding `deviceKey`
 *    into the fast path would device-scope the WARMUP and leave every timed
 *    call on the node's default pool, which is a measurement of the wrong
 *    accelerator reported as the right one. The same goes for `plane`.
 * 2. **`deviceKey` and `plane` reach `runPipeline`, absent when unset.** The
 *    cap has accepted both since the Phase-2 multi-device work; the bench
 *    simply never sent them.
 */
import { describe, expect, it } from 'vitest'
import type { BenchFrame } from '../bench-dispatch.js'
import {
  buildBenchRunPipelineInput,
  canUseCachedFastPath,
  fastPathRefusalReason,
} from '../bench-dispatch.js'

const FRAME: BenchFrame = {
  data: new Uint8Array(3),
  format: 'rgb',
  width: 1,
  height: 1,
  timestamp: 0,
}

const STEPS = [{ addonId: 'object-detection', modelId: 'yolo26n', enabled: true, children: [] }]

describe('canUseCachedFastPath', () => {
  it('takes the fast path for a plain single-step inference bench', () => {
    expect(canUseCachedFastPath(true, {})).toBe(true)
  })

  it('refuses a multi-step tree', () => {
    expect(canUseCachedFastPath(false, {})).toBe(false)
  })

  it('refuses when the caller asked to simulate the pipeline', () => {
    expect(canUseCachedFastPath(true, { simulatePipeline: true })).toBe(false)
  })

  /** `inferCached` has no device selector — see the file header. */
  it('refuses when a deviceKey was requested', () => {
    expect(canUseCachedFastPath(true, { deviceKey: 'openvino:npu' })).toBe(false)
    expect(fastPathRefusalReason({ deviceKey: 'openvino:npu' })).toMatch(/deviceKey/)
  })

  it('refuses when an execution plane was requested', () => {
    expect(canUseCachedFastPath(true, { plane: 'frame' })).toBe(false)
    expect(fastPathRefusalReason({ plane: 'frame' })).toMatch(/plane/)
  })

  it('has no refusal reason for a plain bench', () => {
    expect(fastPathRefusalReason({})).toBeNull()
  })
})

describe('buildBenchRunPipelineInput', () => {
  it('forwards deviceKey and plane to runPipeline', () => {
    const out = buildBenchRunPipelineInput({
      steps: STEPS,
      frame: FRAME,
      deviceKey: 'edgetpu:usb',
      plane: 'frame',
    })
    expect(out.deviceKey).toBe('edgetpu:usb')
    expect(out.plane).toBe('frame')
  })

  it('never forwards an engine override, even one smuggled into the request (D646)', () => {
    const smuggled = {
      steps: STEPS,
      frame: FRAME,
      engine: { runtime: 'python', backend: 'openvino', format: 'openvino', device: 'npu' },
    }
    const out = buildBenchRunPipelineInput(smuggled)
    expect('engine' in out).toBe(false)
  })

  /**
   * Absent, not present-and-undefined: the cap's `deviceKey` omitted means
   * "the runner's default device" and its `plane` omitted means `'full'`.
   */
  it('omits every optional the caller did not set', () => {
    const out = buildBenchRunPipelineInput({ steps: STEPS, frame: FRAME })
    expect(Object.keys(out).toSorted()).toEqual(['frame', 'steps'])
  })
})
