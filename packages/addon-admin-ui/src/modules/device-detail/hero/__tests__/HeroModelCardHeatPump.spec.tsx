import { fireEvent, render, screen, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'
import { HeroModelCard } from '../HeroModelCard'
import { buildModel } from './fixtures'

const host = (run = vi.fn()) => ({ lang: 'en' as const, busy: false, run })

const option = (value: string, allowed: readonly string[]) => ({
  value,
  allowed: [...allowed],
})
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

  it('shows the instantaneous COP, and — while a power is unknown', () => {
    const { unmount } = render(<HeroModelCard model={model(2991)} host={host()} />)
    expect(screen.getByText('Instantaneous COP 3.1')).toBeTruthy()
    unmount()
    render(<HeroModelCard model={model(null)} host={host()} />)
    expect(screen.getByText('Instantaneous COP —')).toBeTruthy()
    expect(screen.getByText('Thermal 9.2 kW')).toBeTruthy()
  })
})

describe('HeroModelCard heat pump selectors', () => {
  it('draws holiday as an off / programme segmented control, not a select, for nine allowed values', () => {
    const run = vi.fn()
    const nine = ['off', 'hm1', 'hm2', 'hm3', 'hm4', 'hm5', 'hm6', 'hm7', 'hm8']
    const base = slice(2991)
    const full = buildModel('heat-pump', ['heat-pump-status', 'heat-pump-control'], {
      'heat-pump-status': {
        ...base,
        system: { ...base.system, holiday: option('off', nine) },
      },
    })
    render(<HeroModelCard model={full} host={host(run)} />)
    const holiday = screen
      .getAllByTestId('hero-row-system-mode')
      .find((row) => within(row).queryByText('Holiday') !== null)
    if (holiday === undefined) throw new Error('no holiday row')
    expect(within(holiday).queryByRole('combobox')).toBeNull()
    expect(within(holiday).getAllByRole('button')).toHaveLength(2)
    fireEvent.click(within(holiday).getByText('Programme'))
    expect(run.mock.calls[0]?.[0].args).toEqual({ mode: 'hm1' })
  })

  it('still draws a circuit whose every value is unknown, with its label', () => {
    const base = slice(2991)
    const blank = {
      ...circuit('hc3', 'Circuit 3'),
      currentTemp: null,
      targetTemp: null,
      operationMode: null,
      comfortSetpoint: null,
      ecoSetpoint: null,
      maxFlowTemp: null,
    }
    const silent = buildModel('heat-pump', ['heat-pump-status', 'heat-pump-control'], {
      'heat-pump-status': { ...base, circuits: [blank] },
    })
    render(<HeroModelCard model={silent} host={host()} />)
    const row = screen.getByTestId('hero-row-circuit')
    expect(within(row).getByText('Circuit 3')).toBeTruthy()
    expect(within(row).getByText('—')).toBeTruthy()
  })

  it('names the active holiday programme in the status', () => {
    const base = slice(2991)
    const on = buildModel('heat-pump', ['heat-pump-status', 'heat-pump-control'], {
      'heat-pump-status': {
        ...base,
        system: {
          ...base.system,
          holiday: option('hm3', ['off', 'hm1', 'hm3']),
        },
      },
    })
    render(<HeroModelCard model={on} host={host()} />)
    expect(screen.getByText('Programme 3')).toBeTruthy()
  })

  it('takes the placeholder of an unset long picker from the i18n key', async () => {
    const instance = createInstance()
    await instance.use(initReactI18next).init({
      lng: 'en',
      resources: {
        en: { translation: { deviceHero: { model: { noValue: 'NOT-SET' } } } },
      },
    })
    const base = slice(2991)
    const unset = buildModel('heat-pump', ['heat-pump-status', 'heat-pump-control'], {
      'heat-pump-status': {
        ...base,
        system: {
          ...base.system,
          silent: {
            value: null,
            allowed: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
          },
        },
      },
    })
    render(
      <I18nextProvider i18n={instance}>
        <HeroModelCard model={unset} host={host()} />
      </I18nextProvider>,
    )
    expect(screen.getByRole('option', { name: 'NOT-SET' })).toBeTruthy()
  })
})
