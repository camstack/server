import { describe, it, expect } from 'vitest'
import {
  supportedRuntimes,
  runtimeDevices,
  defaultDeviceFor,
  pythonRequirementsFor,
  modelFormatFor,
} from '../runtimes.js'
import {
  supportedRuntimes as sharedSupportedRuntimes,
  defaultDeviceFor as sharedDefaultDeviceFor,
} from '@camstack/types'
import type { HardwareInfo } from '@camstack/types'

const N100 = {
  platform: 'linux' as const,
  arch: 'x64',
  hardware: { npu: null, gpu: { type: 'intel' } },
}
const N100_NPU = {
  platform: 'linux' as const,
  arch: 'x64',
  hardware: { npu: { type: 'intel-npu' }, gpu: { type: 'intel' } },
}
const MAC = {
  platform: 'darwin' as const,
  arch: 'arm64',
  hardware: { npu: { type: 'apple-ane' }, gpu: { type: 'apple' } },
}
const LINUX_AMD = {
  platform: 'linux' as const,
  arch: 'x64',
  hardware: { npu: null, gpu: { type: 'amd' } },
}
const PROBE_NULL = { platform: 'linux' as const, arch: 'x64', hardware: null }

describe('supportedRuntimes — hardware-driven, never install-gated', () => {
  it('N100 (x86+Intel, no NPU) offers onnx + openvino, never coreml', () => {
    expect(supportedRuntimes(N100)).toEqual(['onnx', 'openvino'])
  })
  it('Mac offers onnx + coreml, never openvino', () => {
    expect(supportedRuntimes(MAC)).toEqual(['onnx', 'coreml'])
  })
  it('Linux + AMD offers onnx + openvino (OV-CPU for int8 IRs on Zen4)', () => {
    expect(supportedRuntimes(LINUX_AMD)).toEqual(['onnx', 'openvino'])
  })
  it('onnx is always offered, even when probe failed', () => {
    expect(supportedRuntimes(PROBE_NULL)).toContain('onnx')
  })
  it('openvino is withheld when probe failed — onnx floor only (conservative)', () => {
    // probe null on linux x64 → cannot prove Intel; withhold openvino, onnx floor only.
    expect(supportedRuntimes(PROBE_NULL)).toEqual(['onnx'])
  })
})

describe('runtimeDevices — probe-driven, default-only on probe failure', () => {
  it('openvino on N100 (iGPU, no NPU) → AUTO,CPU,GPU (no NPU)', () => {
    expect(runtimeDevices('openvino', N100.hardware).map((d) => d.value)).toEqual([
      'auto',
      'cpu',
      'gpu',
    ])
  })
  it('openvino on N100+NPU → AUTO,CPU,GPU,NPU', () => {
    expect(runtimeDevices('openvino', N100_NPU.hardware).map((d) => d.value)).toEqual([
      'auto',
      'cpu',
      'gpu',
      'npu',
    ])
  })
  it('openvino with probe=null → only the default device (AUTO)', () => {
    expect(runtimeDevices('openvino', null).map((d) => d.value)).toEqual(['auto'])
  })
  it('onnx with probe=null → only CPU (its default)', () => {
    expect(runtimeDevices('onnx', null).map((d) => d.value)).toEqual(['cpu'])
  })
  it('coreml on Apple → ALL,ANE,GPU,CPU', () => {
    expect(runtimeDevices('coreml', MAC.hardware).map((d) => d.value)).toEqual([
      'all',
      'ane',
      'gpu',
      'cpu',
    ])
  })
})

describe('defaults / format / requirements', () => {
  it('default devices: onnx=cpu, openvino=auto, coreml=all', () => {
    expect(defaultDeviceFor('onnx')).toBe('cpu')
    expect(defaultDeviceFor('openvino')).toBe('auto')
    expect(defaultDeviceFor('coreml')).toBe('all')
  })
  it('model format mirrors the runtime', () => {
    expect(modelFormatFor('onnx')).toBe('onnx')
    expect(modelFormatFor('openvino')).toBe('openvino')
    expect(modelFormatFor('coreml')).toBe('coreml')
  })
  it('requirements are base + the runtime-specific file', () => {
    expect(pythonRequirementsFor('openvino')).toEqual([
      'requirements.txt',
      'requirements-openvino.txt',
    ])
    expect(pythonRequirementsFor('onnx')).toEqual([
      'requirements.txt',
      'requirements-onnxruntime.txt',
    ])
    expect(pythonRequirementsFor('coreml')).toEqual(['requirements.txt', 'requirements-coreml.txt'])
  })
})

// ---------------------------------------------------------------------------
// Delegation invariants: shared-rules parity
//
// These tests assert that the re-exported symbols from runtimes.ts delegate
// correctly to `@camstack/types` runtime-capabilities (the shared SSOT).
// They also exercise the new `HardwareInfo`-based path directly via the
// shared exports, confirming the two surfaces agree.
// ---------------------------------------------------------------------------

const INTEL_IGPU_HW: HardwareInfo = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel N100',
  cpuCores: 4,
  totalRAM_MB: 8192,
  availableRAM_MB: 4096,
  gpu: { type: 'intel', name: 'Intel UHD' },
  npu: null,
}

describe('delegation invariants — shared rules agreement', () => {
  it('pythonRequirementsFor("openvino") includes requirements-openvino.txt', () => {
    expect(pythonRequirementsFor('openvino')).toContain('requirements-openvino.txt')
  })

  it('shared supportedRuntimes(HardwareInfo) on Intel iGPU returns [onnx, openvino]', () => {
    expect(sharedSupportedRuntimes(INTEL_IGPU_HW)).toEqual(['onnx', 'openvino'])
  })

  it('local supportedRuntimes(RuntimeEnv) agrees with shared for Intel iGPU', () => {
    const env = {
      platform: 'linux' as const,
      arch: 'x64',
      hardware: { npu: null, gpu: { type: 'intel' } },
    }
    expect(supportedRuntimes(env)).toEqual(sharedSupportedRuntimes(INTEL_IGPU_HW))
  })

  it('shared defaultDeviceFor("openvino") === "auto"', () => {
    expect(sharedDefaultDeviceFor('openvino')).toBe('auto')
  })

  it('local defaultDeviceFor("openvino") agrees with shared', () => {
    expect(defaultDeviceFor('openvino')).toBe(sharedDefaultDeviceFor('openvino'))
  })
})
