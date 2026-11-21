// @vitest-environment jsdom
/**
 * Every connected card gets "on motion" from the shared common hook: the corner
 * data exists only when the device binds `motion-trigger`, implements
 * `setMotionTrigger` and its slice answered; the toggle action sends once.
 */
import type { MotionTriggerStatus } from '@camstack/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCardCommon } from '../connected/use-card-common'

const fake = vi.hoisted(() => ({
  bound: true,
  methods: ['setMotionTrigger'] as readonly string[],
  slice: undefined as MotionTriggerStatus | undefined,
  setMotionTrigger: vi.fn(),
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
  useOptionalSystem: () => null,
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    ...(fake.bound ? { motionTrigger: { setMotionTrigger: fake.setMotionTrigger } } : {}),
    state: { motionTrigger: fake.slice },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'absent',
}))
vi.mock('../../device-picker/device-provider-label', () => ({
  useDeviceProviderLabelsWith: () => new Map<number, string>(),
}))
vi.mock('../../device-history/use-device-history', () => ({
  useDeviceSeriesList: () => ({ data: undefined }),
}))
vi.mock('../../device-history/DeviceHistoryView', () => ({ DeviceHistoryView: () => null }))
vi.mock('../../../generated/system-hooks', () => {
  const query = () => ({ data: undefined })
  const mutation = () => ({ mutateAsync: vi.fn() })
  return {
    useConsumablesReset: mutation,
    useDeviceManagerGetBindings: () => ({
      data: {
        entries: [{ capName: 'motion-trigger', implementedMethods: fake.methods }],
      },
    }),
    useDeviceManagerGetDevice: query,
    usePowerSourceForceRestart: mutation,
    usePowerSourceGetStatus: query,
    usePowerSourcePowerOff: mutation,
    usePowerSourcePowerOn: mutation,
    useRemoteGetAssumedStatus: query,
    useRemoteListCommands: query,
    useRemoteSendCommand: mutation,
    useTemplateList: query,
  }
})

beforeEach(() => {
  fake.bound = true
  fake.methods = ['setMotionTrigger']
  fake.slice = { enabled: true, lastChangedAt: 0 }
  fake.setMotionTrigger.mockReset()
  fake.setMotionTrigger.mockImplementation(() => new Promise(() => undefined))
})
afterEach(cleanup)

const mount = () => renderHook(() => useCardCommon({ deviceId: 1, canActuate: true }))

describe('the shared card hook and "on motion"', () => {
  it('serves the corner data when the device binds motion-trigger', () => {
    expect(mount().result.current.common.motionTrigger).toEqual({ on: true, pending: false })
  })

  it('serves none without the binding, without the method, or before the slice answers', () => {
    fake.bound = false
    expect(mount().result.current.common.motionTrigger).toBeNull()
    fake.bound = true
    fake.methods = []
    expect(mount().result.current.common.motionTrigger).toBeNull()
    fake.methods = ['setMotionTrigger']
    fake.slice = undefined
    expect(mount().result.current.common.motionTrigger).toBeNull()
  })

  it('sends one change per tap and holds the corner while it flies', () => {
    const { result } = mount()
    act(() => {
      result.current.actions.onMotionTrigger?.(false)
      result.current.actions.onMotionTrigger?.(false)
    })
    expect(fake.setMotionTrigger).toHaveBeenCalledTimes(1)
    expect(fake.setMotionTrigger).toHaveBeenCalledWith({ enabled: false })
    expect(result.current.common.motionTrigger).toEqual({ on: true, pending: true })
  })
})
