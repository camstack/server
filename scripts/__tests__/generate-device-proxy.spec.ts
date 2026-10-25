import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const OUTPUT = 'packages/types/src/generated/device-proxy.ts'

describe('generated DeviceProxy', () => {
  const src = readFileSync(OUTPUT, 'utf8')

  it('exports interface DeviceProxy with readonly numeric deviceId', () => {
    expect(src).toMatch(/export interface DeviceProxy\s*\{/)
    expect(src).toMatch(/readonly deviceId: number/)
  })

  it('exports createDeviceProxy factory accepting AddonApi + DeviceBinding + optional stateSource', () => {
    expect(src).toMatch(/export function createDeviceProxy\(/)
    expect(src).toMatch(/api: AddonApi/)
    expect(src).toMatch(/binding: DeviceBinding/)
    expect(src).toMatch(/opts\?: \{ stateSource\?: SliceHandleSource \}/)
  })

  it('imports InferDeviceProxyCap, InferRuntimeState and DeviceBinding types', () => {
    expect(src).toMatch(/InferDeviceProxyCap, InferRuntimeState/)
    expect(src).toMatch(/import type \{ DeviceBinding \}/)
  })

  it('exposes a state namespace with one slot per cap that declares runtimeState', () => {
    // Battery is the canonical runtimeState-bearing cap. The interface
    // bag must surface it as a typed SliceHandle and the factory must
    // wire it via createSliceHandle.
    expect(src).toMatch(/export interface DeviceProxyState\s*\{/)
    expect(src).toMatch(/readonly battery: SliceHandle</)
    expect(src).toMatch(/readonly state: DeviceProxyState/)
    expect(src).toMatch(
      /battery: createSliceHandle<.*>\(stateSource, binding\.deviceId, 'battery'\)/,
    )
  })

  it('imports SliceHandle helpers from device/device-state-handle', () => {
    expect(src).toMatch(/from '\.\.\/device\/device-state-handle\.js'/)
    expect(src).toMatch(/createSliceHandle, createLazyTrpcSource/)
    expect(src).toMatch(/type SliceHandleSource/)
  })

  it('omits unbound device-scoped caps from the factory return', () => {
    expect(src).toMatch(/function bound\(capName: string\)/)
    expect(src).toMatch(
      /\.\.\.\(bound\('device-admin-link'\) \? \{ deviceAdminLink: deviceAdminLinkInterface \} : \{\}\)/,
    )
  })

  // Until Phase 5 lands, no PTZ/events/snapshot caps are device-scoped.
  // After Phase 5 adds them, uncomment the following:
  // it('exposes optional fields for known device-scoped caps', () => {
  //   expect(src).toMatch(/readonly ptz\?: InferDeviceProxyCap/)
  //   expect(src).toMatch(/readonly events\?: InferDeviceProxyCap/)
  //   expect(src).toMatch(/readonly snapshot\?: InferDeviceProxyCap/)
  // })
})
