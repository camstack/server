import { describe, it, expect } from 'vitest'
import { supportedRuntimes, scoreRuntimes, defaultDeviceFor } from '../runtime-capabilities.js'
import type { HardwareInfo } from '../../interfaces/platform.js'

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
const nvidia: HardwareInfo = {
  ...base,
  platform: 'linux',
  arch: 'x64',
  gpu: { type: 'nvidia', name: 'RTX' },
  npu: null,
}
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
  it('nvidia → best cuda 85', () => expect(scoreRuntimes(nvidia).best.backend).toBe('cuda'))
  it('apple → best coreml 95', () => expect(scoreRuntimes(apple).best.backend).toBe('coreml'))
  it('plain x86 → best cpu 50', () => expect(scoreRuntimes(plainX86).best.backend).toBe('cpu'))
})
describe('defaultDeviceFor', () => {
  it('openvino → auto', () => expect(defaultDeviceFor('openvino')).toBe('auto'))
})
