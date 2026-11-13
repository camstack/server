// @vitest-environment jsdom
/**
 * A seeded change time (Homematic's `1`) is not an instant. The offline line
 * must stay empty rather than say "Offline for 20,000 d".
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const status = vi.hoisted(() => ({
  online: false,
  lastChangedAt: 1,
}))

vi.mock('../../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))

vi.mock('../../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    state: {
      deviceStatus: { online: status.online, lastChangedAt: status.lastChangedAt },
    },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))

vi.mock('../../../../generated/system-hooks', () => ({
  useDeviceManagerGetDevice: () => ({ data: undefined }),
  useDeviceManagerGetBindings: () => ({ data: undefined }),
  usePowerSourceGetStatus: () => ({ data: undefined, refetch: () => undefined }),
  usePowerSourcePowerOn: () => ({ mutate: () => undefined }),
  usePowerSourcePowerOff: () => ({ mutate: () => undefined }),
  usePowerSourceForceRestart: () => ({ mutate: () => undefined }),
  useRemoteListCommands: () => ({ data: undefined }),
  useRemoteGetAssumedStatus: () => ({ data: undefined }),
  useTemplateList: () => ({ data: undefined, status: 'pending' }),
  useRemoteSendCommand: () => ({ mutate: () => undefined }),
  useConsumablesReset: () => ({ mutate: () => undefined }),
}))

vi.mock('../../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'absent',
}))

vi.mock('../../../device-picker/device-provider-label', () => ({
  useDeviceProviderLabelsWith: () => new Map(),
}))

vi.mock('../../../device-history/use-device-history', () => ({
  useDeviceSeriesList: () => ({ presence: 'absent', list: { status: 'pending' } }),
}))

import { useCardCommon } from '../use-card-common'

const MINUTE_MS = 60_000

describe('useCardCommon offline line', () => {
  it('says nothing for a seeded change time, and names a real one', () => {
    status.online = false
    status.lastChangedAt = 1
    const seeded = renderHook(() => useCardCommon({ deviceId: 1, canActuate: true }))
    expect(seeded.result.current.common.online).toBe(false)
    expect(seeded.result.current.common.offlineLabel).toBeNull()

    status.lastChangedAt = Date.now() - 5 * MINUTE_MS
    const real = renderHook(() => useCardCommon({ deviceId: 1, canActuate: true }))
    expect(real.result.current.common.offlineLabel).toBe('Offline for 5 min')
  })
})
