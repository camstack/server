// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { DeviceStatus } from '@camstack/types'

/**
 * The hook collapses three (now four) preconditions into one `available`
 * boolean and exposes the resolved device online status. We mock the
 * underlying `useDeviceProxy` / `useDeviceStateSlice` primitives so the
 * test drives the cap handle, the domain slice, and the device-status
 * slice independently — exactly the inputs the gate combines.
 */

interface MockState {
  readonly switch: { readonly slice: 'switch-handle' }
  readonly deviceStatus: { readonly slice: 'device-status-handle' }
}

interface MockDeviceProxy {
  readonly state: MockState
  readonly switch?: { readonly id: 'switch-cap' }
}

// Domain slice value that the `slice` accessor resolves to.
const SWITCH_SLICE = { on: true }

let mockDev: MockDeviceProxy | null
// Keyed by the handle the slice accessor returns, so each
// useDeviceStateSlice call resolves to its own value.
let sliceValues: Map<unknown, unknown>

vi.mock('../use-device-proxy', () => ({
  useDeviceProxy: () => mockDev,
  useDeviceStateSlice: (handle: unknown) =>
    handle === undefined ? undefined : sliceValues.get(handle),
}))

import { useDeviceCapability } from '../use-device-capability'

const makeProxy = (withCap: boolean): MockDeviceProxy => ({
  state: {
    switch: { slice: 'switch-handle' },
    deviceStatus: { slice: 'device-status-handle' },
  },
  ...(withCap ? { switch: { id: 'switch-cap' } } : {}),
})

const trpc = {
  deviceManager: { getBindings: { query: async () => ({}) } },
} as never

const callHook = () =>
  useDeviceCapability<{ readonly id: 'switch-cap' }, typeof SWITCH_SLICE>({
    trpc,
    deviceId: 1,
    cap: (d) => (d as unknown as MockDeviceProxy).switch,
    slice: (d) => (d as unknown as MockDeviceProxy).state.switch as never,
  })

beforeEach(() => {
  mockDev = makeProxy(true)
  sliceValues = new Map<unknown, unknown>()
  // Domain slice landed.
  sliceValues.set(mockDev.state.switch, SWITCH_SLICE)
})

describe('useDeviceCapability — offline gating', () => {
  it('available=false when device-status slice reports online=false (even with cap+slice+feature present)', () => {
    const status: DeviceStatus = { online: false, lastChangedAt: 4242 }
    sliceValues.set(mockDev!.state.deviceStatus, status)

    const { result } = renderHook(callHook)

    expect(result.current.available).toBe(false)
    expect(result.current.online).toBe(false)
    expect(result.current.offlineSince).toBe(4242)
  })

  it('available=true when device-status slice reports online=true and other preconditions met', () => {
    const status: DeviceStatus = { online: true, lastChangedAt: 1000 }
    sliceValues.set(mockDev!.state.deviceStatus, status)

    const { result } = renderHook(callHook)

    expect(result.current.available).toBe(true)
    expect(result.current.online).toBe(true)
    expect(result.current.offlineSince).toBeNull()
  })

  it('defaults online=true and leaves available unchanged when device-status slice has not landed', () => {
    // No device-status slice value set → useDeviceStateSlice returns undefined.
    const { result } = renderHook(callHook)

    expect(result.current.online).toBe(true)
    expect(result.current.available).toBe(true)
    expect(result.current.offlineSince).toBeNull()
  })
})
