import { describe, it, expect } from 'vitest'
import type { HardwareInfo } from '../interfaces/platform.js'
import { scoreRuntimes, enumerateInferenceDevices, runtimeDevices } from './runtime-capabilities.js'

const intelHub: HardwareInfo = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel N100',
  cpuCores: 4,
  totalRAM_MB: 16000,
  availableRAM_MB: 12000,
  gpu: { type: 'intel', name: 'Intel UHD' },
  npu: null,
  coral: null,
}

describe('scoreRuntimes edgetpu branch', () => {
  it('omits edgetpu when no Coral is present', () => {
    const { scores } = scoreRuntimes(intelHub)
    expect(scores.some((s) => s.backend === 'edgetpu')).toBe(false)
  })

  it('emits a scored edgetpu entry when a Coral is present', () => {
    const withCoral: HardwareInfo = {
      ...intelHub,
      coral: { type: 'coral-edgetpu', bus: 'usb' },
    }
    const { scores } = scoreRuntimes(withCoral)
    const edge = scores.find((s) => s.backend === 'edgetpu')
    expect(edge).toBeDefined()
    expect(edge?.format).toBe('tflite')
    expect(edge?.score).toBe(70)
    expect(edge?.available).toBe(true)
    expect(edge?.runtime).toBe('python')
  })

  it('orders edgetpu below OpenVINO GPU (80) and above CPU (50)', () => {
    const withCoral: HardwareInfo = {
      ...intelHub,
      coral: { type: 'coral-edgetpu', bus: 'usb' },
    }
    const { scores } = scoreRuntimes(withCoral)
    const order = scores.map((s) => s.backend)
    expect(order.indexOf('openvino')).toBeLessThan(order.indexOf('edgetpu'))
    expect(order.indexOf('edgetpu')).toBeLessThan(order.indexOf('cpu'))
  })
})

describe('enumerateInferenceDevices', () => {
  it('lists openvino gpu + cpu on an Intel node without Coral', () => {
    const devices = enumerateInferenceDevices(intelHub)
    const keys = devices.map((d) => d.key)
    expect(keys).toContain('openvino:gpu')
    expect(keys).toContain('cpu')
    expect(keys).not.toContain('edgetpu:usb')
  })

  it('adds edgetpu:usb (tflite) when a Coral is present', () => {
    const withCoral: HardwareInfo = {
      ...intelHub,
      coral: { type: 'coral-edgetpu', bus: 'usb' },
    }
    const devices = enumerateInferenceDevices(withCoral)
    const edge = devices.find((d) => d.key === 'edgetpu:usb')
    expect(edge).toBeDefined()
    expect(edge?.backend).toBe('edgetpu')
    expect(edge?.device).toBe('usb')
    expect(edge?.format).toBe('tflite')
    expect(edge?.score).toBe(70)
  })

  it('emits one descriptor per physical Coral when several are attached', () => {
    const twoCorals: HardwareInfo = {
      ...intelHub,
      coral: { type: 'coral-edgetpu', bus: 'usb', count: 2 },
    }
    const devices = enumerateInferenceDevices(twoCorals)
    const edgeKeys = devices.filter((d) => d.backend === 'edgetpu').map((d) => d.key)
    // First Coral keeps the bare `edgetpu:usb` key (backward compatible + = first
    // available); additional units get ordinal keys.
    expect(edgeKeys).toEqual(['edgetpu:usb', 'edgetpu:usb:1'])
    const second = devices.find((d) => d.key === 'edgetpu:usb:1')
    expect(second?.device).toBe('usb:1')
    expect(second?.format).toBe('tflite')
  })

  it('uses a bare "cpu" key for the CPU floor', () => {
    const devices = enumerateInferenceDevices(intelHub)
    expect(devices.find((d) => d.backend === 'cpu')?.key).toBe('cpu')
  })

  it('expands OpenVINO into npu + gpu (not a duplicate cpu) when an Intel NPU is present', () => {
    const withNpu: HardwareInfo = { ...intelHub, npu: { type: 'intel-npu' } }
    const devices = enumerateInferenceDevices(withNpu)
    const keys = devices.map((d) => d.key)
    expect(keys).toContain('openvino:npu')
    expect(keys).toContain('openvino:gpu')
    // no duplicate CPU device — only the universal `cpu` floor
    expect(keys).not.toContain('openvino:cpu')
    expect(keys.filter((k) => k === 'cpu' || k.endsWith(':cpu')).length).toBe(1)
    // NPU scored above the iGPU (faster + frees the GPU)
    const npu = devices.find((d) => d.key === 'openvino:npu')!
    const gpu = devices.find((d) => d.key === 'openvino:gpu')!
    expect(npu.score).toBeGreaterThan(gpu.score)
  })

  it('emits onnx:webgpu + openvino:cpu on AMD (iGPU + Zen4 int8 paths)', () => {
    const amd: HardwareInfo = {
      ...intelHub,
      gpu: { type: 'amd', name: 'AMD Radeon 760M' },
      npu: { type: 'amd-xdna', generation: 'xdna1' },
    }
    const devices = enumerateInferenceDevices(amd)
    const keys = devices.map((d) => d.key)
    expect(keys).toContain('onnx:webgpu')
    expect(keys).toContain('openvino:cpu')
    expect(keys).toContain('cpu')
    expect(keys).not.toContain('openvino:gpu')
    expect(keys).not.toContain('openvino:npu')
    const webgpu = devices.find((d) => d.key === 'onnx:webgpu')!
    expect(webgpu.format).toBe('onnx')
    expect(webgpu.score).toBe(75)
    const ovCpu = devices.find((d) => d.key === 'openvino:cpu')!
    expect(ovCpu.format).toBe('openvino')
    expect(ovCpu.score).toBe(65)
  })

  it('offers no WebGPU on a Windows AMD node: the plugin is not provisioned there', () => {
    const amdWindows: HardwareInfo = {
      ...intelHub,
      platform: 'win32',
      gpu: { type: 'amd', name: 'AMD Radeon 780M' },
      npu: { type: 'amd-xdna', generation: 'xdna1' },
    }
    const keys = enumerateInferenceDevices(amdWindows).map((d) => d.key)
    expect(keys).not.toContain('onnx:webgpu')
    // OpenVINO CPU and the CPU floor remain.
    expect(keys).toContain('openvino:cpu')
    expect(keys).toContain('cpu')
    expect(scoreRuntimes(amdWindows).best.backend).toBe('openvino')
    expect(runtimeDevices('onnx', amdWindows).map((d) => d.value)).not.toContain('webgpu')
    // Linux still gets it.
    expect(
      runtimeDevices('onnx', { ...amdWindows, platform: 'linux' }).map((d) => d.value),
    ).toContain('webgpu')
  })
})
