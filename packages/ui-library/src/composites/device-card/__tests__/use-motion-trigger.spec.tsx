// @vitest-environment jsdom
/**
 * The shared hook behind every connected card's "on motion" corner: the served
 * slice only, nothing without the binding or the method, one send per change.
 */
import type { MotionTriggerRuntimeState } from '@camstack/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMotionTrigger } from '../connected/use-motion-trigger'

const hub = vi.hoisted(() => ({
  bound: true,
  slice: undefined as MotionTriggerRuntimeState | undefined,
  setMotionTrigger: vi.fn(),
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
  useOptionalSystem: () => null,
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    ...(hub.bound ? { motionTrigger: { setMotionTrigger: hub.setMotionTrigger } } : {}),
    state: { motionTrigger: hub.slice },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))

const fail = vi.fn()
const succeed = vi.fn()

function motionOn(settable: boolean): boolean | null {
  return renderHook(() => useMotionTrigger({ deviceId: 1, settable, fail, succeed })).result.current
    .on
}

beforeEach(() => {
  hub.bound = true
  hub.slice = { enabled: true, lastChangedAt: 0, lastFetchedAt: 0 }
  hub.setMotionTrigger.mockReset()
  hub.setMotionTrigger.mockImplementation(() => new Promise(() => undefined))
})
afterEach(cleanup)

describe('useMotionTrigger', () => {
  it('reads the served value', () => {
    expect(motionOn(true)).toBe(true)
  })

  it('reads the cold-start seed as unknown, and a read camera that is off as off', () => {
    hub.slice = { enabled: false, lastChangedAt: 0, lastFetchedAt: 0 }
    const seed = renderHook(() => useMotionTrigger({ deviceId: 1, settable: true, fail, succeed }))
      .result.current
    expect(seed.present).toBe(true)
    expect(seed.on).toBeNull()
    hub.slice = { enabled: false, lastChangedAt: 0, lastFetchedAt: 1_700_000_000_000 }
    expect(motionOn(true)).toBe(false)
    hub.slice = { enabled: false, lastChangedAt: 1_700_000_000_000, lastFetchedAt: 0 }
    expect(motionOn(true)).toBe(false)
  })

  it('offers nothing without the binding, the method, or an answered slice', () => {
    hub.bound = false
    expect(motionOn(true)).toBeNull()
    hub.bound = true
    expect(motionOn(false)).toBeNull()
    hub.slice = undefined
    expect(motionOn(true)).toBeNull()
  })

  it('sends one change per claim and reports pending', () => {
    const { result } = renderHook(() =>
      useMotionTrigger({ deviceId: 1, settable: true, fail, succeed }),
    )
    act(() => {
      result.current.onToggle(false)
      result.current.onToggle(false)
    })
    expect(hub.setMotionTrigger).toHaveBeenCalledTimes(1)
    expect(hub.setMotionTrigger).toHaveBeenCalledWith({ enabled: false })
    expect(result.current.pending).toBe(true)
    expect(result.current.on).toBe(true)
  })
})
