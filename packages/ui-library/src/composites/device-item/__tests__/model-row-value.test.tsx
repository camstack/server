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
import { formatControlDateTime } from '../../../lib/format-control-datetime'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rowModels: { status: 'pending' } as Record<string, unknown>,
  mutate: vi.fn<(input: unknown) => Promise<unknown>>(),
  getBindings: vi.fn(async () => ({
    deviceId: 1,
    entries: ['control', 'button', 'script-runner', 'automation-control'].map((capName) => ({
      capName,
      providerNodeId: 'agent-1',
    })),
  })),
  alert: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
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
    button: { press: { mutate: h.mutate } },
    scriptRunner: { run: { mutate: h.mutate } },
    automationControl: {
      trigger: { mutate: h.mutate },
      enable: { mutate: h.mutate },
      disable: { mutate: h.mutate },
    },
  }),
}))
vi.mock('../../confirm-dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../confirm-dialog')>()),
  useAlertIfAvailable: () => h.alert,
  useConfirmIfAvailable: () => h.confirm,
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
  extra: {
    readonly display?: DeviceDisplayOverride
    readonly sourceInfo?: SourceInfo
    readonly type?: string
  } = {},
): RowValueDevice {
  return { id: 1, role: null, type: DeviceType.Control, ...extra }
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
    render(<ModelRowControl device={device()} />)
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
    render(<ModelRowControl device={device()} />)
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
    render(<ModelRowControl device={device()} />)
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
    render(<ModelRowControl device={device()} />)
    const select = screen.getByRole('combobox')
    selectOption(select, 'Eco')
    await waitFor(() =>
      expect(h.alert).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'device offline', variant: 'danger' }),
      ),
    )
    await waitFor(() => expect(select.textContent).toBe('Comfort'))
  })

  it('a date is read out from the model, never typed over (the row keeps it read-only)', () => {
    answer([controlRow({ kind: 'datetime', value: '2026-11-12T10:00:00Z' })])
    render(<ModelRowControl device={device()} />)
    expect(screen.getByTestId('row-readout').textContent).toBe('2026-11-12T10:00:00Z')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('a date control with a shape is read out in the locale, not as the raw value', () => {
    answer([controlRow({ kind: 'datetime', value: '2026-11-12' })])
    render(
      <ModelRowControl device={device({ sourceInfo: { id: 'd', system: 'ha', dateTimeShape: 'date' } })} />,
    )
    const text = screen.getByTestId('row-readout').textContent
    expect(text).toBe(formatControlDateTime('2026-11-12', 'date'))
    expect(text).not.toBe('2026-11-12')
  })
})

function modelRow(type: string, cap: string, slice: Record<string, unknown>): unknown {
  return projectDeviceRow(
    buildHeroModel({
      device: { id: 1, type, role: null, name: 'Dev', online: true },
      caps: [cap],
      features: [],
      slices: { [cap]: slice },
      now: 1_700_000_000_000,
      remoteCommands: null,
      access: { canActuate: true },
    }),
  )
}

describe('the wave E rows draw the projected model, the same one the card reads', () => {
  it('a button row asks what the model says to ask, then presses the cap call', async () => {
    answer([modelRow(DeviceType.Button, 'button', {})])
    render(<ModelRowControl device={device({ type: DeviceType.Button })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Press' }))
    await waitFor(() => expect(h.mutate).toHaveBeenCalled())
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Run' }))
    expect(lastSent()).toMatchObject({ deviceId: 1, nodeId: 'agent-1' })
  })

  it('a declined confirmation presses nothing', async () => {
    h.confirm.mockResolvedValueOnce(false)
    answer([modelRow(DeviceType.Button, 'button', {})])
    render(<ModelRowControl device={device({ type: DeviceType.Button })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Press' }))
    await waitFor(() => expect(h.confirm).toHaveBeenCalled())
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('a script row runs the script', async () => {
    answer([modelRow(DeviceType.Script, 'script-runner', { isRunning: false, lastRunAt: null })])
    render(<ModelRowControl device={device({ type: DeviceType.Script })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(h.mutate).toHaveBeenCalled())
  })

  it('an automation row has its Run now AND its enabled switch (the row extra)', async () => {
    // The row's extras are pinned in the types package (`hero-row-extras.spec.ts`); the
    // projection is taken here with the extras the model itself offers.
    const model = buildHeroModel({
      device: { id: 1, type: DeviceType.Automation, role: null, name: 'Auto', online: true },
      caps: ['automation-control'],
      features: [],
      slices: {
        'automation-control': { enabled: true, isRunning: false, lastTriggeredAt: 0, lastError: null, lastChangedAt: 0 },
      },
      now: 1_700_000_000_000,
      remoteCommands: null,
      access: { canActuate: true },
    })
    const extras = model.rows.flatMap((r) => r.controls).filter((c) => c.kind === 'toggle')
    answer([{ ...projectDeviceRow(model), extras }])
    render(<ModelRowControl device={device({ type: DeviceType.Automation })} />)
    expect(screen.getByRole('button', { name: 'Run now' })).toBeTruthy()
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(h.mutate).toHaveBeenCalled())
  })

  it('an update row reads out the model’s state, and offers nothing to press', () => {
    answer([
      modelRow(DeviceType.Update, 'update', {
        currentVersion: '1.0',
        availableVersion: '1.1',
        updatable: true,
        state: null,
        inProgress: false,
      }),
    ])
    render(<ModelRowControl device={device({ type: DeviceType.Update })} />)
    expect(screen.getByTestId('row-readout').textContent).toBe('Update available')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a notifier or gateway row has no control and no readout', () => {
    answer([modelRow(DeviceType.Notifier, 'notifier', {})])
    const { container } = render(<ModelRowControl device={device({ type: DeviceType.Notifier })} />)
    expect(container.textContent).toBe('')
  })

  it('an unanswered device draws nothing (never a stand-in control)', () => {
    answer([null])
    const { container } = render(<ModelRowControl device={device({ type: DeviceType.Button })} />)
    expect(container.textContent).toBe('')
  })
})

describe('row control states', () => {
  it('nothing while the row model is unanswered', () => {
    h.rowModels = { status: 'pending' }
    const { container } = render(<ModelRowControl device={device()} />)
    expect(container.textContent).toBe('')
  })
})
