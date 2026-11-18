import { describe, it, expect } from 'vitest'
import {
  supportedRuntimes,
  scoreRuntimes,
  defaultDeviceFor,
  enumerateInferenceDevices,
  runtimeDevices,
  describeNvidia,
} from '../runtime-capabilities.js'
import type { HardwareInfo, NvidiaInfo } from '../../interfaces/platform.js'

const base = {
  cpuModel: 'x',
  cpuCores: 4,
  totalRAM_MB: 8000,
  availableRAM_MB: 4000,
}
const intelIgpu: HardwareInfo = {
  ...base,
  platform: 'linux',
  arch: 'x64',
  gpu: { type: 'intel', name: 'iGPU' },
  npu: null,
}
const intelNpu: HardwareInfo = { ...intelIgpu, npu: { type: 'intel-npu' } }
const rtxIdle: NvidiaInfo = describeNvidia({ name: 'RTX 2060' }, ['CPUExecutionProvider'])
const rtxCuda: NvidiaInfo = describeNvidia({ name: 'RTX 2060' }, [
  'CUDAExecutionProvider',
  'CPUExecutionProvider',
])
const nvidia: HardwareInfo = {
  ...base,
  platform: 'linux',
  arch: 'x64',
  gpu: null,
  npu: null,
  nvidia: rtxIdle,
}
// i7-8700K (UHD 630) + RTX 2060: the iGPU in `gpu`, the NVIDIA card in its own slot.
const i7WithRtx: HardwareInfo = { ...intelIgpu, nvidia: rtxIdle }
const apple: HardwareInfo = {
  ...base,
  platform: 'darwin',
  arch: 'arm64',
  gpu: { type: 'apple', name: 'M' },
  npu: { type: 'apple-ane' },
}
const plainX86: HardwareInfo = {
  ...base,
  platform: 'linux',
  arch: 'x64',
  gpu: null,
  npu: null,
}
const amdPhoenix: HardwareInfo = {
  ...base,
  platform: 'linux',
  arch: 'x64',
  gpu: { type: 'amd', name: 'AMD Radeon 760M (gfx1103)' },
  npu: { type: 'amd-xdna', name: 'AMD XDNA1 NPU', generation: 'xdna1' },
}

describe('supportedRuntimes', () => {
  it('intel iGPU → onnx + openvino', () =>
    expect(supportedRuntimes(intelIgpu)).toEqual(['onnx', 'openvino']))
  it('amd iGPU → onnx + openvino (CPU path)', () =>
    expect(supportedRuntimes(amdPhoenix)).toEqual(['onnx', 'openvino']))
  it('nvidia → onnx only', () => expect(supportedRuntimes(nvidia)).toEqual(['onnx']))
  it('apple → onnx + coreml', () => expect(supportedRuntimes(apple)).toEqual(['onnx', 'coreml']))
  it('plain x86 → onnx floor', () => expect(supportedRuntimes(plainX86)).toEqual(['onnx']))
  it('null → onnx floor', () => expect(supportedRuntimes(null)).toEqual(['onnx']))
})
describe('scoreRuntimes', () => {
  it('intel iGPU → best openvino 80 available', () => {
    const { best } = scoreRuntimes(intelIgpu)
    expect(best.backend).toBe('openvino')
    expect(best.score).toBe(80)
    expect(best.available).toBe(true)
  })
  it('intel iGPU + NPU → openvino 90', () => expect(scoreRuntimes(intelNpu).best.score).toBe(90))
  it('amd iGPU → best onnx WebGPU 75', () => {
    const { best } = scoreRuntimes(amdPhoenix)
    expect(best.backend).toBe('onnx')
    expect(best.score).toBe(75)
    expect(best.reason).toBe('ONNX WebGPU (AMD iGPU)')
  })
  it('nvidia without the CUDA execution provider → no cuda, cpu floor', () => {
    const { scores, best } = scoreRuntimes(nvidia)
    expect(scores.some((s) => s.backend === 'cuda')).toBe(false)
    expect(best.backend).toBe('cpu')
  })
  it('nvidia with the CUDA execution provider → best cuda 85', () =>
    expect(scoreRuntimes({ ...nvidia, nvidia: rtxCuda }).best.backend).toBe('cuda'))
  it('a gpu.type nvidia from an older node is not a cuda device', () =>
    expect(
      scoreRuntimes({ ...nvidia, nvidia: null, gpu: { type: 'nvidia', name: 'RTX' } }).scores.some(
        (s) => s.backend === 'cuda',
      ),
    ).toBe(false))
  it('apple → best coreml 95', () => expect(scoreRuntimes(apple).best.backend).toBe('coreml'))
  it('plain x86 → best cpu 50', () => expect(scoreRuntimes(plainX86).best.backend).toBe('cpu'))
})
describe('cuda is offered only when the CUDA EP exists', () => {
  it('an NVIDIA host without it enumerates no cuda device', () =>
    expect(enumerateInferenceDevices(nvidia).map((d) => d.key)).toEqual(['cpu']))
  it('an NVIDIA host without it offers no cuda device on the onnx runtime', () =>
    expect(runtimeDevices('onnx', nvidia).map((d) => d.value)).toEqual(['cpu']))
  it('i7-8700K + RTX 2060, no CUDA EP → openvino:gpu offered, no cuda', () => {
    const keys = enumerateInferenceDevices(i7WithRtx).map((d) => d.key)
    expect(keys).toContain('openvino:gpu')
    expect(keys.some((k) => k.startsWith('cuda'))).toBe(false)
    expect(supportedRuntimes(i7WithRtx)).toContain('openvino')
  })
  it('i7-8700K + RTX 2060 with the CUDA EP → openvino:gpu and cuda coexist', () => {
    const keys = enumerateInferenceDevices({ ...i7WithRtx, nvidia: rtxCuda }).map((d) => d.key)
    expect(keys).toContain('openvino:gpu')
    expect(keys).toContain('cuda:gpu')
  })
})
describe('describeNvidia', () => {
  it('no CUDA EP → present, not usable, with the reason', () =>
    expect(rtxIdle).toEqual({
      type: 'nvidia',
      name: 'RTX 2060',
      usable: false,
      reason: 'no-cuda-execution-provider',
    }))
  it('an unreported EP list is not usable either', () =>
    expect(describeNvidia({ name: 'x' }, null).usable).toBe(false))
  it('CUDA EP listed → usable', () => expect(rtxCuda.usable).toBe(true))
})
describe('defaultDeviceFor', () => {
  it('openvino → auto', () => expect(defaultDeviceFor('openvino')).toBe('auto'))
})
