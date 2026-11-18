/**
 * The executor's own node enumeration (`envToHardwareInfo` →
 * `enumerateInferenceDevices`) reads NVIDIA from its own slot, never from
 * `gpu`: the iGPU keeps `openvino:gpu`, and `cuda:gpu` appears only once the
 * slot is usable (the CUDA execution provider exists).
 */
import { enumerateInferenceDevices, describeNvidia, type NvidiaInfo } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { envToHardwareInfo, type RuntimeEnv } from '../runtimes.js'

const RTX = { name: 'NVIDIA GeForce RTX 2060' }

function i7WithRtx(nvidia: NvidiaInfo): RuntimeEnv {
  return { platform: 'linux', arch: 'x64', hardware: { npu: null, gpu: { type: 'intel' }, nvidia } }
}

function keys(env: RuntimeEnv): readonly string[] {
  return enumerateInferenceDevices(envToHardwareInfo(env)).map((d) => d.key)
}

describe('the NVIDIA slot reaches the executor node enumeration', () => {
  it('without the CUDA EP: openvino:gpu on the iGPU, no cuda device', () => {
    const k = keys(i7WithRtx(describeNvidia(RTX, ['CPUExecutionProvider'])))
    expect(k).toContain('openvino:gpu')
    expect(k.some((key) => key.startsWith('cuda'))).toBe(false)
  })

  it('with the CUDA EP: openvino:gpu and cuda:gpu coexist', () => {
    const k = keys(
      i7WithRtx(describeNvidia(RTX, ['CUDAExecutionProvider', 'CPUExecutionProvider'])),
    )
    expect(k).toContain('openvino:gpu')
    expect(k).toContain('cuda:gpu')
  })
})
