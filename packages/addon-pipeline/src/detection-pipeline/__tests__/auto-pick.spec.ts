import { describe, it, expect } from 'vitest'
import { pickBestRuntime } from '../auto-pick.js'

const N100 = {
  platform: 'linux' as const,
  arch: 'x64',
  hardware: { npu: null, gpu: { type: 'intel' } },
}
const MAC = {
  platform: 'darwin' as const,
  arch: 'arm64',
  hardware: { npu: { type: 'apple-ane' }, gpu: { type: 'apple' } },
}
const PROBE_NULL = { platform: 'linux' as const, arch: 'x64', hardware: null }

describe('pickBestRuntime', () => {
  it('Intel N100 → openvino/auto', () => {
    expect(pickBestRuntime(N100, 'openvino')).toEqual({ runtimeId: 'openvino', device: 'auto' })
  })
  it('Mac → coreml/all', () => {
    expect(pickBestRuntime(MAC, 'coreml')).toEqual({ runtimeId: 'coreml', device: 'all' })
  })
  it('probe null → onnx/cpu floor', () => {
    expect(pickBestRuntime(PROBE_NULL, null)).toEqual({ runtimeId: 'onnx', device: 'cpu' })
  })
  it('ignores a best-hint that is not supported on this hardware', () => {
    // hint says coreml but we are on linux Intel → fall to best supported (openvino)
    expect(pickBestRuntime(N100, 'coreml')).toEqual({ runtimeId: 'openvino', device: 'auto' })
  })
})
