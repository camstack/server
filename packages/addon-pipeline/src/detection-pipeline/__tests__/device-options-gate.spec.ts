/**
 * Unit tests for the probe-driven device-option gating in the Runtime Registry.
 *
 * `runtimeDevices(backend, hardware)` returns only the device options valid on
 * this host's hardware:
 *
 *  openvino — `gpu` only on Intel GPU, `npu` only on Intel NPU; `auto`/`cpu`
 *             always present (probe null → AUTO only).
 *  onnx    — `cuda` only on NVIDIA, `coreml` EP only on Apple ANE; `cpu` always
 *             present (probe null → CPU only).
 *  coreml  — `ane` only when Apple ANE present.
 *
 * (Replaces the old `filterDeviceOptionsByHardware` tests; that helper was
 * removed when the offer became registry-driven.)
 */
import { describe, expect, it } from 'vitest'
import { runtimeDevices } from '../runtimes.js'

describe('runtimeDevices — openvino', () => {
  it('shows AUTO,CPU,GPU when Intel iGPU present, no NPU', () => {
    expect(
      runtimeDevices('openvino', { npu: null, gpu: { type: 'intel' } }).map((o) => o.value),
    ).toEqual(['auto', 'cpu', 'gpu'])
  })
  it('adds NPU when Intel NPU present', () => {
    expect(
      runtimeDevices('openvino', { npu: { type: 'intel-npu' }, gpu: { type: 'intel' } }).map(
        (o) => o.value,
      ),
    ).toEqual(['auto', 'cpu', 'gpu', 'npu'])
  })
  it('probe null → AUTO only', () => {
    expect(runtimeDevices('openvino', null).map((o) => o.value)).toEqual(['auto'])
  })
})

describe('runtimeDevices — onnx', () => {
  it('adds CUDA only on NVIDIA', () => {
    expect(
      runtimeDevices('onnx', { npu: null, gpu: { type: 'nvidia' } }).map((o) => o.value),
    ).toContain('cuda')
    expect(
      runtimeDevices('onnx', { npu: null, gpu: { type: 'intel' } }).map((o) => o.value),
    ).not.toContain('cuda')
  })
  it('probe null → CPU only', () => {
    expect(runtimeDevices('onnx', null).map((o) => o.value)).toEqual(['cpu'])
  })
})

describe('runtimeDevices — coreml', () => {
  it('adds ANE only when apple-ane present', () => {
    expect(
      runtimeDevices('coreml', { npu: { type: 'apple-ane' }, gpu: { type: 'apple' } }).map(
        (o) => o.value,
      ),
    ).toContain('ane')
    expect(
      runtimeDevices('coreml', { npu: null, gpu: { type: 'intel' } }).map((o) => o.value),
    ).not.toContain('ane')
  })
})
