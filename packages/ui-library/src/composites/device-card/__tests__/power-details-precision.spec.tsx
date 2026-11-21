// @vitest-environment jsdom
/**
 * The Precision set in Customize is about the device's PRIMARY reading; the
 * secondary power-meter rows (voltage, current, power factor, energy) follow the
 * default rule (at most two decimals, trimmed), whatever the device precision.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCardCommon } from '../connected/use-card-common'

const fake = vi.hoisted(() => ({
  precision: undefined as number | undefined,
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
  useOptionalSystem: () => ({
    getDeviceInfo: () => ({ display: { precision: fake.precision } }),
  }),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    powerMeter: {},
    state: {
      powerMeter: {
        power: 120,
        voltage: 230.4123,
        current: 0.4,
        powerFactor: 0.95,
        energy: 12.345,
      },
    },
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
        entries: [{ capName: 'power-meter', implementedMethods: [] as readonly string[] }],
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

afterEach(cleanup)

const detailsFor = (precision: number | undefined) => {
  fake.precision = precision
  const { result } = renderHook(() => useCardCommon({ deviceId: 1, canActuate: true }))
  const out: Record<string, string> = {}
  for (const d of result.current.common.power?.details ?? []) out[d.id] = d.value
  return out
}

describe('power-meter detail rows and the device precision', () => {
  it('keeps the default rule with no precision set', () => {
    expect(detailsFor(undefined)).toMatchObject({
      voltage: '230.41 V',
      current: '0.4 A',
      powerFactor: '0.95',
      energy: '12.35 kWh',
    })
  })

  it('does not apply a precision of 0 to the secondary rows', () => {
    expect(detailsFor(0)).toMatchObject({ powerFactor: '0.95', current: '0.4 A' })
  })

  it('does not apply a precision of 3 to the secondary rows', () => {
    expect(detailsFor(3)).toMatchObject({ voltage: '230.41 V' })
  })
})
