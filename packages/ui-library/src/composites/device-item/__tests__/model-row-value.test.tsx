/**
 * The model-drawn row value: a Sensor row's measurement through the operator's
 * display resolution, and a Control row's primary control — shown and typed in the
 * display unit, sent in the base unit, routed to the cap's node, optimistic while
 * the write travels, reported when refused.
 */
import {
  buildHeroModel,
  DeviceType,
  powerMeasurement,
  projectDeviceRow,
  temperatureMeasurement,
  type DeviceDisplayOverride,
  type SourceInfo,
} from '@camstack/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rowModels: { status: 'pending' } as Record<string, unknown>,
  mutate: vi.fn<(input: unknown) => Promise<unknown>>(),
  getBindings: vi.fn(async () => ({
    deviceId: 1,
    entries: [{ capName: 'control', providerNodeId: 'agent-1' }],
  })),
  alert: vi.fn(async () => undefined),
  refetch: vi.fn(async () => undefined),
}))

vi.mock('../../../generated/system-hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../generated/system-hooks')>()),
  useHeroLayoutGetRowModels: () => ({ ...h.rowModels, refetch: h.refetch }),
}))
vi.mock('../../hero-model/use-hero-live-refresh', () => ({ useHeroLiveRefresh: () => undefined }))
vi.mock('../../../contexts/system-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../contexts/system-context')>()),
  useTrpcClient: () => ({
    deviceManager: { getBindings: { query: h.getBindings } },
    control: { setValue: { mutate: h.mutate } },
  }),
}))
vi.mock('../../confirm-dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../confirm-dialog')>()),
  useAlertIfAvailable: () => h.alert,
}))

import { UnitPreferencesProvider } from '../../../contexts/unit-preferences'
import { selectOption } from '../../../testing/select-option'
import { ModelRowControl, ModelRowReading, type RowValueDevice } from '../model-row-value'

const FAHRENHEIT = { system: 'metric', temperature: 'fahrenheit' } as const

function answer(rows: readonly unknown[]): void {
  h.rowModels = { status: 'success', data: rows }
}

function controlRow(slice: Record<string, unknown>): unknown {
  return projectDeviceRow(
    buildHeroModel({
      device: { id: 1, type: DeviceType.Control, role: null, name: 'Ctl', online: true },
      caps: ['control'],
      features: [],
      slices: { control: { options: [], lastChangedAt: 0, ...slice } },
      now: 1_700_000_000_000,
      remoteCommands: null,
      access: { canActuate: true },
    }),
  )
}

function device(
  extra: { readonly display?: DeviceDisplayOverride; readonly sourceInfo?: SourceInfo } = {},
): RowValueDevice {
  return { id: 1, role: null, ...extra }
}

function inFahrenheit(node: ReactNode): ReactNode {
  return <UnitPreferencesProvider value={FAHRENHEIT}>{node}</UnitPreferencesProvider>
}

const lastSent = (): unknown => h.mutate.mock.calls.at(-1)?.[0]

afterEach(() => {
  vi.clearAllMocks()
  h.mutate.mockImplementation(async () => undefined)
})

describe('a Sensor row reads its measurement as the operator displays it', () => {
  it('a Fahrenheit preference shows °F', () => {
    answer([{ measurement: temperatureMeasurement(48, null), primary: null }])
    render(inFahrenheit(<ModelRowReading device={device()} fallback="atom" />))
    const text = screen.getByTestId('row-measurement').textContent ?? ''
    expect(text).toMatch(/°F$/)
    expect(Number.parseFloat(text)).toBeCloseTo(118.4, 0)
  })

  it('a kW override on the device shows kW', () => {
    answer([{ measurement: powerMeasurement(1221, null), primary: null }])
    render(<ModelRowReading device={device({ display: { unit: 'kW' } })} fallback="atom" />)
    const text = screen.getByTestId('row-measurement').textContent ?? ''
    expect(text).toMatch(/kW$/)
    expect(Number.parseFloat(text)).toBeCloseTo(1.2, 1)
  })
})

describe('a Control row edits its primary control', () => {
  it('a number without bounds: shown in °F, typed 70 °F is sent as ≈21.1 °C, to the cap node', async () => {
    answer([controlRow({ kind: 'numeric', value: 20 })])
    render(
      inFahrenheit(
        <ModelRowControl
          device={device({ sourceInfo: { id: 'ctl', system: 'test', quantity: 'temperature' } })}
          fallback="own"
        />,
      ),
    )
    const input = screen.getByRole('spinbutton')
    expect(Number(input.getAttribute('value'))).toBeCloseTo(68, 5)
    expect(screen.getByText('°F')).toBeTruthy()
    fireEvent.change(input, { target: { value: '70' } })
    await waitFor(() => expect(h.mutate).toHaveBeenCalled())
    const sent = lastSent()
    expect(sent).toMatchObject({ deviceId: 1, nodeId: 'agent-1', control: { kind: 'numeric' } })
    expect((sent as { control: { value: number } }).control.value).toBeCloseTo(21.11, 1)
  })

  it('a number with bounds is clamped to them', async () => {
    answer([controlRow({ kind: 'numeric', value: 2, min: 0, max: 10, step: 1 })])
    render(<ModelRowControl device={device()} fallback="own" />)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '50' } })
    await waitFor(() => expect(h.mutate).toHaveBeenCalled())
    expect(lastSent()).toMatchObject({ control: { kind: 'numeric', value: 10 } })
  })

  it('a choice shows the chosen option at once, while the write travels', async () => {
    let settle: () => void = () => undefined
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve(undefined)
        }),
    )
    answer([controlRow({ kind: 'select', value: 'Comfort', options: ['Eco', 'Comfort'] })])
    render(<ModelRowControl device={device()} fallback="own" />)
    const select = screen.getByRole('combobox')
    selectOption(select, 'Eco')
    expect(select.textContent).toBe('Eco')
    await waitFor(() => expect(h.mutate).toHaveBeenCalled())
    expect(lastSent()).toMatchObject({ control: { kind: 'select', value: 'Eco' } })
    await act(async () => settle())
    await waitFor(() => expect(h.refetch).toHaveBeenCalled())
  })

  it('a text field sends what was typed', async () => {
    answer([controlRow({ kind: 'text', value: 'Back on Monday' })])
    render(<ModelRowControl device={device()} fallback="own" />)
    const input = screen.getByDisplayValue('Back on Monday')
    fireEvent.change(input, { target: { value: 'Away' } })
    fireEvent.blur(input)
    await waitFor(() => expect(h.mutate).toHaveBeenCalled())
    expect(lastSent()).toMatchObject({ control: { kind: 'text', value: 'Away' } })
  })

  it('a refused write is reported and the read-back value returns', async () => {
    h.mutate.mockImplementation(async () => {
      throw new Error('device offline')
    })
    answer([controlRow({ kind: 'select', value: 'Comfort', options: ['Eco', 'Comfort'] })])
    render(<ModelRowControl device={device()} fallback="own" />)
    const select = screen.getByRole('combobox')
    selectOption(select, 'Eco')
    await waitFor(() =>
      expect(h.alert).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'device offline', variant: 'danger' }),
      ),
    )
    await waitFor(() => expect(select.textContent).toBe('Comfort'))
  })

  it('a date, an action or a toggle draws the row’s own control', () => {
    answer([controlRow({ kind: 'datetime', value: '2026-11-12T10:00:00Z' })])
    const { unmount } = render(<ModelRowControl device={device()} fallback="own" />)
    expect(screen.getByText('own')).toBeTruthy()
    unmount()
    answer([{ primary: { kind: 'toggle', id: 'power' } }])
    render(<ModelRowControl device={device()} fallback="own" />)
    expect(screen.getByText('own')).toBeTruthy()
  })

  it('nothing while the row model is unanswered', () => {
    h.rowModels = { status: 'pending' }
    const { container } = render(<ModelRowControl device={device()} fallback="own" />)
    expect(container.textContent).toBe('')
  })
})
