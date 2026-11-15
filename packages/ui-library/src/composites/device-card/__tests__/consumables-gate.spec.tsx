// @vitest-environment jsdom
/**
 * D315 on the card's consumables chip: "not bound" draws nothing, "bound and
 * the slice has not arrived" draws loading, "bound and empty" says so. An
 * unanswered read must never look like "no consumables".
 */
import type { ConsumablesStatus } from '@camstack/types'
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { useCardCommon } from '../connected/use-card-common'
import { DeviceCard } from '../shell/DeviceCard'
import type { CardCommon } from '../shell/model'

const fake = vi.hoisted(() => ({
  bound: false,
  slice: undefined as ConsumablesStatus | undefined,
}))

vi.mock('../../../contexts/system-context', () => ({ useTrpcClient: () => ({}) }))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    consumables: fake.bound ? {} : undefined,
    state: { consumables: fake.slice },
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
    useDeviceManagerGetBindings: query,
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

afterEach(() => {
  cleanup()
  fake.bound = false
  fake.slice = undefined
})

const commonOf = (): CardCommon => {
  fake.bound = true
  return renderHook(() => useCardCommon({ deviceId: 1, canActuate: true })).result.current.common
}

describe('the consumables gate in the card hook', () => {
  it('not bound: no consumables, not loading', () => {
    fake.bound = false
    const { common } = renderHook(() => useCardCommon({ deviceId: 1, canActuate: true })).result
      .current
    expect(common.consumables).toBeNull()
    expect(common.consumablesLoading).toBe(false)
  })

  it('bound, slice not arrived: loading, never an empty list', () => {
    fake.slice = undefined
    const common = commonOf()
    expect(common.consumables).toBeNull()
    expect(common.consumablesLoading).toBe(true)
  })

  it('bound, slice answered empty: an empty list', () => {
    fake.slice = { items: [], lastChangedAt: 0 }
    const common = commonOf()
    expect(common.consumables).toEqual([])
    expect(common.consumablesLoading).toBe(false)
  })
})

describe('the consumables gate on the card', () => {
  const base = (): CardCommon => {
    const model = plugFixtures(0)[0]?.model
    if (model === undefined) throw new Error('no plug fixture')
    return model.common
  }
  const draw = (over: Partial<CardCommon>) =>
    render(
      <DeviceCard
        kind="plug"
        common={{ ...base(), ...over }}
        state={{ label: 'On', since: null, tone: 'primary' }}
        scene={{ image: <span>scene</span> }}
      />,
    )

  it('unbound draws no chip', () => {
    draw({ consumables: null, consumablesLoading: false })
    expect(screen.queryByTestId('dc-consumables')).toBeNull()
  })

  it('bound and pending draws loading', () => {
    draw({ consumables: null, consumablesLoading: true })
    expect(screen.getByTestId('dc-consumables-loading')).toBeTruthy()
  })

  it('bound and empty draws the empty line', () => {
    draw({ consumables: [], consumablesLoading: false })
    expect(screen.getByTestId('dc-consumables-empty')).toBeTruthy()
  })
})
