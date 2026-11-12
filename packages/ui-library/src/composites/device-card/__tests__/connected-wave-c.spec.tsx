// @vitest-environment jsdom
/**
 * The Wave-C connected cards against a fake hub: which capability a command
 * reaches. A heat pump writes a circuit's mode / hot-water level and its
 * system modes through `heat-pump-control`, each only when declared and
 * implemented; a water heater steps its target within range, changes mode,
 * toggles away and powers off through the `off` mode.
 */
import {
  DeviceType,
  type HeatPumpCircuit,
  type HeatPumpStatus,
  type WaterHeaterStatus,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedHeatPumpCard } from '../connected/ConnectedHeatPumpCard'
import { ConnectedWaterHeaterCard } from '../connected/ConnectedWaterHeaterCard'

const CIRCUIT: HeatPumpCircuit = {
  id: 'hc1',
  kind: 'heating',
  label: 'Circuit 1',
  icon: 'flame',
  currentTemp: 21,
  targetTemp: 21,
  mode: 'auto',
  active: true,
  operationMode: { value: 'auto', allowed: ['auto', 'manual', 'off'] },
  heatCoolMode: null,
  summerWinter: null,
  comfortSetpoint: null,
  ecoSetpoint: null,
  maxFlowTemp: null,
  temperatureLevel: null,
  chargeDuration: null,
  extraHotWater: null,
}

const DHW: HeatPumpCircuit = {
  ...CIRCUIT,
  id: 'dhw1',
  kind: 'dhw',
  label: 'Hot water',
  currentTemp: 53,
  targetTemp: 51,
  active: false,
  operationMode: null,
  temperatureLevel: { value: 'eco', allowed: ['off', 'low', 'high', 'eco'] },
}

const HEAT_PUMP: HeatPumpStatus = {
  circuits: [CIRCUIT, DHW],
  system: {
    silent: { value: 'off', allowed: ['off', 'on'] },
    away: { value: 'off', allowed: ['off', 'on'] },
    additionalHeater: { value: 'auto', allowed: ['auto', 'manual', 'off'] },
    holiday: { value: 'off', allowed: ['off', 'hm1', 'hm2'] },
  },
  power: { thermalW: 6200, electricalW: 1600, compressorPct: 45 },
  temperatures: { supply: 34.5, return: 29.8, outdoor: 8.3 },
  energy: { thermalKwh: null, electricalKwh: null },
  waterPressureBar: 1.6,
  starts: null,
  lastFetchedAt: 0,
}

const WATER: WaterHeaterStatus = {
  currentTemp: 48,
  targetTemp: 60,
  operationMode: 'eco',
  availableModes: ['off', 'eco', 'performance'],
  away: false,
  minTemp: 30,
  maxTemp: 60,
  lastActiveMode: 'performance',
  lastChangedAt: 0,
}

const hub = vi.hoisted(() => ({
  hp: {
    setSilentMode: vi.fn(),
    setAwayMode: vi.fn(),
    setAdditionalHeaterMode: vi.fn(),
    setHolidayMode: vi.fn(),
    setCircuitOperationMode: vi.fn(),
    setDhwOperationMode: vi.fn(),
    setDhwTemperatureLevel: vi.fn(),
  },
  wh: { setTargetTemp: vi.fn(), setOperationMode: vi.fn(), setAway: vi.fn() },
  hpSlice: null as HeatPumpStatus | null,
  whSlice: null as WaterHeaterStatus | null,
  /** Null: the binding lists no methods, so every method of the cap is offered. */
  methods: null as Readonly<Record<string, readonly string[]>> | null,
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    heatPumpStatus: hub.hpSlice === null ? undefined : {},
    heatPumpControl: hub.hpSlice === null ? undefined : hub.hp,
    waterHeater: hub.whSlice === null ? undefined : hub.wh,
    state: {
      heatPumpStatus: hub.hpSlice ?? undefined,
      waterHeater: hub.whSlice ?? undefined,
    },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../connected/use-card-common', async () => {
  const { useCommandNotice } = await import('../connected/use-command-notice')
  return {
    useCardCommon: () => {
      const { notice, fail, succeed } = useCommandNotice()
      const common = plugFixtures(0)[0]?.model.common
      if (common === undefined) throw new Error('no plug fixture')
      return {
        common: {
          ...common,
          power: null,
          consumables: null,
          supply: null,
          remote: null,
          battery: null,
          notice,
        },
        actions: {},
        deviceType: DeviceType.HeatPump,
        role: null,
        features: [],
        implements: (cap: string, method: string): boolean => {
          if (hub.methods === null) return true
          const listed = hub.methods[cap]
          return listed !== undefined && listed.includes(method)
        },
        fail,
        succeed,
      }
    },
  }
})

const allFns = (): readonly ReturnType<typeof vi.fn>[] => [
  ...Object.values(hub.hp),
  ...Object.values(hub.wh),
]

beforeEach(() => {
  for (const fn of allFns()) {
    fn.mockReset()
    fn.mockResolvedValue(undefined)
  }
  hub.hpSlice = null
  hub.whSlice = null
  hub.methods = null
})
afterEach(cleanup)

describe('a heat pump', () => {
  it('draws the readings, the compressor and the pump’s own draw in the corner', () => {
    hub.hpSlice = HEAT_PUMP
    render(<ConnectedHeatPumpCard deviceId={1} optimistic={false} />)
    expect(screen.getByTestId('dc-hp-temps').textContent).toContain('8.3°')
    expect(screen.getByTestId('dc-hp-power').textContent).toContain('3.9')
    expect(screen.getByTestId('dc-hp-compressor').textContent).toContain('45%')
    expect(screen.getByText('1600 W')).toBeTruthy()
  })

  it('offers all four system modes the gateway declares, and writes each through its method', async () => {
    hub.hpSlice = HEAT_PUMP
    render(<ConnectedHeatPumpCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-hp-system-silent'))
    await vi.waitFor(() => expect(hub.hp.setSilentMode).toHaveBeenCalledWith({ mode: 'on' }))
    fireEvent.click(screen.getByTestId('dc-hp-system-away'))
    await vi.waitFor(() => expect(hub.hp.setAwayMode).toHaveBeenCalledWith({ mode: 'on' }))
    fireEvent.click(screen.getByTestId('dc-hp-system-holiday'))
    await vi.waitFor(() => expect(hub.hp.setHolidayMode).toHaveBeenCalledWith({ mode: 'hm1' }))
    expect(screen.getByTestId('dc-hp-system-additionalHeater')).toBeTruthy()
  })

  it('draws no system mode the gateway does not declare, nor one the binding does not implement', () => {
    hub.hpSlice = {
      ...HEAT_PUMP,
      system: { ...HEAT_PUMP.system, away: null, holiday: { value: null, allowed: [] } },
    }
    hub.methods = {
      'heat-pump-control': ['setAwayMode', 'setHolidayMode', 'setAdditionalHeaterMode'],
    }
    render(<ConnectedHeatPumpCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-hp-system-silent')).toBeNull()
    expect(screen.queryByTestId('dc-hp-system-away')).toBeNull()
    expect(screen.queryByTestId('dc-hp-system-holiday')).toBeNull()
    expect(screen.getByTestId('dc-hp-system-additionalHeater')).toBeTruthy()
  })

  it('sets a heating circuit’s mode and the hot water’s level through their methods', async () => {
    hub.hpSlice = HEAT_PUMP
    render(<ConnectedHeatPumpCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-hp-circuit-hc1'))
    fireEvent.click(screen.getByRole('radio', { name: 'Manual' }))
    await vi.waitFor(() =>
      expect(hub.hp.setCircuitOperationMode).toHaveBeenCalledWith({
        circuitId: 'hc1',
        mode: 'manual',
      }),
    )
    fireEvent.click(screen.getByTestId('dc-hp-circuit-dhw1'))
    fireEvent.click(screen.getByRole('radio', { name: 'High' }))
    await vi.waitFor(() =>
      expect(hub.hp.setDhwTemperatureLevel).toHaveBeenCalledWith({
        circuitId: 'dhw1',
        level: 'high',
      }),
    )
  })

  it('offers no circuit picker whose method the binding does not implement', () => {
    hub.hpSlice = HEAT_PUMP
    hub.methods = { 'heat-pump-control': ['setSilentMode'] }
    render(<ConnectedHeatPumpCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-hp-circuit-hc1'))
    expect(screen.queryByRole('radio', { name: 'Manual' })).toBeNull()
    fireEvent.click(screen.getByTestId('dc-hp-circuit-dhw1'))
    expect(screen.queryByRole('radio', { name: 'High' })).toBeNull()
  })

  it('draws nothing until the status has answered', () => {
    const { container } = render(<ConnectedHeatPumpCard deviceId={1} />)
    expect(container.textContent).toBe('')
  })
})

describe('a water heater', () => {
  it('steps the target and stops at its maximum', async () => {
    hub.whSlice = { ...WATER, targetTemp: 59 }
    render(<ConnectedWaterHeaterCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Raise target' }))
    await vi.waitFor(() => expect(hub.wh.setTargetTemp).toHaveBeenCalledWith({ temp: 60 }))
    cleanup()
    hub.whSlice = { ...WATER, targetTemp: 60 }
    render(<ConnectedWaterHeaterCard deviceId={1} optimistic={false} />)
    expect(screen.getByRole('button', { name: 'Raise target' }).hasAttribute('disabled')).toBe(true)
  })

  it('turns off through the off mode and back on in the last mode it ran', async () => {
    hub.whSlice = WATER
    render(<ConnectedWaterHeaterCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-wh-power'))
    await vi.waitFor(() => expect(hub.wh.setOperationMode).toHaveBeenCalledWith({ mode: 'off' }))
    cleanup()
    hub.whSlice = { ...WATER, operationMode: 'off' }
    render(<ConnectedWaterHeaterCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-wh-power'))
    await vi.waitFor(() =>
      expect(hub.wh.setOperationMode).toHaveBeenCalledWith({ mode: 'performance' }),
    )
  })

  it('toggles away, and draws no away button when the device has none', async () => {
    hub.whSlice = WATER
    render(<ConnectedWaterHeaterCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-wh-away'))
    await vi.waitFor(() => expect(hub.wh.setAway).toHaveBeenCalledWith({ on: true }))
    cleanup()
    hub.whSlice = { ...WATER, away: null }
    render(<ConnectedWaterHeaterCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-wh-away')).toBeNull()
  })

  it('has no power button when its modes cannot switch it off', () => {
    hub.whSlice = { ...WATER, availableModes: ['eco', 'performance'] }
    render(<ConnectedWaterHeaterCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-wh-power')).toBeNull()
  })

  it('keeps the mode menu open when no mode is reported and nothing can switch it off', () => {
    hub.whSlice = { ...WATER, availableModes: ['eco', 'performance'], operationMode: null }
    render(<ConnectedWaterHeaterCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-wh-power')).toBeNull()
    expect(screen.getByTestId('dc-wh-mode').hasAttribute('disabled')).toBe(false)
  })
})
