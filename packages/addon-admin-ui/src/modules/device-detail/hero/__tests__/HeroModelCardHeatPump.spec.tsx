import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeroModelCard } from '../HeroModelCard'
import { buildModel } from './fixtures'

const host = (run = vi.fn()) => ({ lang: 'en' as const, busy: false, run })

const option = (value: string, allowed: readonly string[]) => ({ value, allowed: [...allowed] })
const range = { value: 21, min: 5, max: 30, step: 0.5 }

const circuit = (id: string, label: string) => ({
  id,
  kind: 'heating',
  label,
  icon: 'flame',
  currentTemp: 20.1,
  targetTemp: 30,
  mode: 'manual',
  active: false,
  operationMode: option('manual', ['off', 'manual', 'auto']),
  heatCoolMode: null,
  summerWinter: null,
  comfortSetpoint: range,
  ecoSetpoint: range,
  maxFlowTemp: range,
  temperatureLevel: null,
  chargeDuration: null,
  extraHotWater: null,
})

const slice = (electricalW: number | null) => ({
  circuits: [circuit('hc1', 'Circuit 1'), circuit('hc2', 'Circuit 2')],
  system: {
    silent: option('off', ['off', 'auto', 'on']),
    away: option('off', ['off', 'on']),
    additionalHeater: option('off', ['off', 'manual', 'auto']),
    holiday: option('off', ['off', 'hm1', 'hm2']),
  },
  power: { thermalW: 9200, electricalW, compressorPct: 18 },
  temperatures: { supply: 59.7, return: 52.3, outdoor: 8.8 },
  energy: { thermalKwh: null, electricalKwh: null },
  waterPressureBar: 1.8,
  starts: 494,
  lastFetchedAt: 1,
})

const model = (electricalW: number | null) =>
  buildModel('heat-pump', ['heat-pump-status', 'heat-pump-control'], {
    'heat-pump-status': slice(electricalW),
  })

describe('HeroModelCard heat pump', () => {
  it('draws each circuit under its own label and the System group once, with a selector per mode', () => {
    render(<HeroModelCard model={model(2991)} host={host()} />)
    const circuits = screen.getAllByTestId('hero-row-circuit')
    expect(circuits).toHaveLength(2)
    expect(within(circuits[0] as HTMLElement).getByText('Circuit 1')).toBeTruthy()
    expect(within(circuits[1] as HTMLElement).getByText('Circuit 2')).toBeTruthy()
    expect(screen.getAllByTestId('hero-row-group')).toHaveLength(1)
    expect(screen.getAllByTestId('hero-row-system-mode')).toHaveLength(4)
  })

  it('a click on a circuit mode calls its typed method with the circuit and the value', () => {
    const run = vi.fn()
    render(<HeroModelCard model={model(2991)} host={host(run)} />)
    const first = screen.getAllByTestId('hero-row-circuit')[0] as HTMLElement
    fireEvent.click(within(first).getByText('Auto'))
    expect(run).toHaveBeenCalledWith(
      {
        cap: 'heat-pump-control',
        method: 'setCircuitOperationMode',
        args: { circuitId: 'hc1', mode: 'auto' },
      },
      null,
    )
  })

  it('shows the instantaneous COP pill only while both powers are known', () => {
    const { unmount } = render(<HeroModelCard model={model(2991)} host={host()} />)
    expect(screen.getByText('Instantaneous COP 3.1')).toBeTruthy()
    unmount()
    render(<HeroModelCard model={model(null)} host={host()} />)
    expect(screen.queryByText(/COP/)).toBeNull()
    expect(screen.getByText('Thermal 9.2 kW')).toBeTruthy()
  })
})
