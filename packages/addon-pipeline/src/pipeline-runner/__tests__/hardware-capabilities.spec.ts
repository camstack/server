/**
 * `RunnerLocalLoad.hardware` — the block that reported a hardcoded
 * `hasGpu: false` on a node actively running OpenVINO on its Intel iGPU.
 */
import { describe, expect, it } from 'vitest'
import { summarizeRunnerHardware } from '../hardware-capabilities.js'

describe('summarizeRunnerHardware', () => {
  it('a node with an Intel iGPU reports hasGpu:true', () => {
    expect(summarizeRunnerHardware({ gpu: { type: 'intel' }, npu: null }, 4).hasGpu).toBe(true)
  })

  it('an NVIDIA node reports hasGpu:true', () => {
    expect(summarizeRunnerHardware({ gpu: { type: 'nvidia' }, npu: null }, 8).hasGpu).toBe(true)
  })

  it('a CPU-only node reports hasGpu:false', () => {
    expect(summarizeRunnerHardware({ gpu: null, npu: null }, 4).hasGpu).toBe(false)
  })

  it('hasGpu is literal — an NPU alone is not a GPU', () => {
    expect(summarizeRunnerHardware({ gpu: null, npu: { type: 'intel-npu' } }, 4).hasGpu).toBe(false)
  })

  it('a failed / absent probe floors to false rather than claiming a GPU', () => {
    expect(summarizeRunnerHardware(null, 4).hasGpu).toBe(false)
  })

  it('carries the core count through', () => {
    expect(summarizeRunnerHardware(null, 12).cpuCores).toBe(12)
  })

  it('leaves inferenceBackend absent — a node runs a pool per accelerator', () => {
    expect(summarizeRunnerHardware({ gpu: { type: 'intel' }, npu: null }, 4).inferenceBackend).toBe(
      undefined,
    )
  })
})
