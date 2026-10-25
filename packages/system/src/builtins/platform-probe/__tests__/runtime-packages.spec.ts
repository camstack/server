import { describe, it, expect } from 'vitest'
import { resolveRuntimePackages } from '../runtime-packages.js'

const base = {
  arch: 'x64',
  cpuModel: '',
  cpuCores: 4,
  totalRAM_MB: 8000,
  availableRAM_MB: 4000,
} as const

describe('resolveRuntimePackages', () => {
  it('linux non-Intel -> onnx baseline only', () => {
    const r = resolveRuntimePackages({
      ...base,
      platform: 'linux',
      gpu: null,
      npu: null,
    })
    expect(r.requirementsFiles).toEqual(['requirements-onnxruntime.txt'])
    expect(r.backendIds).toEqual(['onnx-py'])
  })
  it('linux + Intel NPU -> onnx baseline + openvino', () => {
    const r = resolveRuntimePackages({
      ...base,
      platform: 'linux',
      gpu: { type: 'intel', name: 'i' },
      npu: { type: 'intel-npu' },
    })
    expect(r.requirementsFiles).toContain('requirements-openvino.txt')
    expect(r.backendIds).toContain('openvino')
  })
  it('linux + AMD iGPU -> onnx + openvino + webgpu', () => {
    const r = resolveRuntimePackages({
      ...base,
      platform: 'linux',
      gpu: { type: 'amd', name: 'Radeon 760M' },
      npu: { type: 'amd-xdna', name: 'AMD XDNA1 NPU', generation: 'xdna1' },
    })
    expect(r.requirementsFiles).toContain('requirements-openvino.txt')
    expect(r.requirementsFiles).toContain('requirements-webgpu.txt')
    expect(r.backendIds).toContain('openvino')
    expect(r.backendIds).toContain('webgpu')
  })
  it('darwin -> coreml + onnx baseline, never openvino', () => {
    const r = resolveRuntimePackages({
      ...base,
      platform: 'darwin',
      gpu: { type: 'apple', name: 'a' },
      npu: { type: 'apple-ane' },
    })
    expect(r.backendIds).toEqual(expect.arrayContaining(['coreml', 'onnx-py']))
    expect(r.requirementsFiles).not.toContain('requirements-openvino.txt')
  })
  it('win32 + Intel iGPU -> onnx baseline + openvino (the wheels exist on Windows)', () => {
    const r = resolveRuntimePackages({
      ...base,
      platform: 'win32',
      gpu: { type: 'intel', name: 'Intel UHD' },
      npu: null,
    })
    expect(r.requirementsFiles).toContain('requirements-openvino.txt')
    expect(r.backendIds).toEqual(expect.arrayContaining(['onnx-py', 'openvino']))
  })
  it('win32 + AMD iGPU -> openvino CPU but NOT webgpu (a separate device key comes later)', () => {
    const r = resolveRuntimePackages({
      ...base,
      platform: 'win32',
      gpu: { type: 'amd', name: 'Radeon 780M' },
      npu: { type: 'amd-xdna', name: 'AMD XDNA1 NPU', generation: 'xdna1' },
    })
    expect(r.requirementsFiles).toContain('requirements-openvino.txt')
    expect(r.requirementsFiles).not.toContain('requirements-webgpu.txt')
    expect(r.backendIds).not.toContain('webgpu')
  })
  it('win32 with no Intel/AMD accelerator -> onnx baseline only', () => {
    const r = resolveRuntimePackages({
      ...base,
      platform: 'win32',
      gpu: { type: 'nvidia', name: 'RTX 3060' },
      npu: null,
    })
    expect(r.requirementsFiles).toEqual(['requirements-onnxruntime.txt'])
  })
})
