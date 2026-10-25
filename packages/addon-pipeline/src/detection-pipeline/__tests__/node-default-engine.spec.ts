/**
 * Node-default engine derivation — pool COLLAPSE invariant (Block D1 / NEW-1).
 *
 * The elected single-engine cascade was removed: a `deviceKey`-less / lone
 * session routes to the node-DEFAULT pool. That default MUST be the same
 * CONCRETE device (`openvino:npu`, not the abstract `openvino:auto`) the
 * orchestrator balances over, so `resolveDeviceFactory`'s
 * `enginesEqual(engine, currentEngine)` reuse fires and the default pool and the
 * balanced top-device pool are ONE pool — never two contending on the same
 * physical accelerator (double model load / VRAM).
 *
 * This asserts the pure derivation rule `resolveAutoEngine` applies:
 *   resolveDeviceEngine(enumerateInferenceDevices(hw)[0].key)
 */
import { describe, it, expect } from 'vitest'
import { enumerateInferenceDevices } from '@camstack/types'
import { resolveDeviceEngine } from '../engine/resolve-device-engine.js'
import { envToHardwareInfo } from '../runtimes.js'

const HUB_ENV = {
  platform: 'linux' as const,
  arch: 'x64',
  hardware: { npu: { type: 'intel-npu' }, gpu: { type: 'intel' } },
}
const N100_ENV = {
  platform: 'linux' as const,
  arch: 'x64',
  hardware: { npu: null, gpu: { type: 'intel' } },
}
const CPU_ONLY_ENV = { platform: 'linux' as const, arch: 'x64', hardware: null }

function nodeDefaultEngine(env: typeof HUB_ENV | typeof N100_ENV | typeof CPU_ONLY_ENV) {
  const devices = enumerateInferenceDevices(envToHardwareInfo(env))
  const top = devices.find((d) => d.available) ?? devices[0]
  return top ? resolveDeviceEngine(top.key) : null
}

describe('node-default engine derivation (pool collapse)', () => {
  it('hub NPU+iGPU → the CONCRETE openvino:npu engine (never the abstract auto)', () => {
    const engine = nodeDefaultEngine(HUB_ENV)
    expect(engine).toEqual({
      runtime: 'python',
      backend: 'openvino',
      format: 'openvino',
      device: 'npu',
    })
    // device is concrete — an `'auto'` here would spawn a third pool.
    expect(engine?.device).not.toBe('auto')
  })

  it('is IDENTICAL to what a balanced openvino:npu session resolves — they share one pool', () => {
    expect(nodeDefaultEngine(HUB_ENV)).toEqual(resolveDeviceEngine('openvino:npu'))
  })

  it('N100 iGPU-only → openvino:gpu (top device, no NPU to prefer)', () => {
    expect(nodeDefaultEngine(N100_ENV)).toEqual(resolveDeviceEngine('openvino:gpu'))
  })

  it('CPU-only node → the bare cpu floor (onnx), not an abstract accelerator auto', () => {
    const engine = nodeDefaultEngine(CPU_ONLY_ENV)
    expect(engine).toEqual(resolveDeviceEngine('cpu'))
    expect(engine?.format).toBe('onnx')
  })
})
