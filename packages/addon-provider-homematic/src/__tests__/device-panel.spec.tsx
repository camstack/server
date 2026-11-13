/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import type { CcuDeviceState, ValueParam } from '../ccu/ccu-schemas.js'
import type { CcuTrpc } from '../ui/ccu-client.js'
import { DevicePanel } from '../ui/DevicePanel.js'
import { asEditable, parseValueEdit, valueText } from '../ui/value-format.js'

const ADDRESS = '00315F298E5093'

function param(seed: Partial<ValueParam> & { readonly parameter: string }): ValueParam {
  return {
    type: 'FLOAT',
    min: null,
    max: null,
    unit: null,
    valueList: null,
    writable: false,
    readable: true,
    value: null,
    ...seed,
  }
}

const STATE: CcuDeviceState = {
  address: ADDRESS,
  name: 'Bagno',
  type: 'HmIP-BSM',
  firmware: { installed: '1.4.8', available: '1.6.2', updatable: true, state: 'READY_FOR_UPDATE' },
  diagnostics: {
    rssiDevice: -64,
    rssiPeer: -71,
    unreach: false,
    lowBattery: true,
    dutyCycle: false,
    configPending: false,
  },
  channels: [
    {
      address: `${ADDRESS}:1`,
      index: 1,
      type: 'KEY_TRANSCEIVER',
      name: 'Bagno sinistra',
      values: [
        param({ parameter: 'PRESS_SHORT', type: 'ACTION', writable: true, readable: false }),
      ],
    },
    {
      address: `${ADDRESS}:4`,
      index: 4,
      type: 'SWITCH_VIRTUAL_RECEIVER',
      name: 'Luce bagno',
      values: [
        param({ parameter: 'STATE', type: 'BOOL', writable: true, value: true }),
        param({ parameter: 'ON_TIME', writable: true, unit: 's', min: 0, max: 111600 }),
        param({
          parameter: 'PROCESS',
          type: 'ENUM',
          valueList: ['STABLE', 'NOT_STABLE'],
          value: 0,
        }),
      ],
    },
  ],
}

type Handler = (input: Record<string, unknown>) => unknown

function fakeTrpc(handlers: Record<string, Handler>): CcuTrpc {
  return {
    addons: {
      custom: {
        mutate: async ({ action, input }) => {
          const handler = handlers[action]
          if (handler === undefined) throw new Error(`unexpected action ${action}`)
          return handler(typeof input === 'object' && input !== null ? { ...input } : {})
        },
      },
    },
  }
}

function mount(handlers: Record<string, Handler>) {
  return render(
    <ConfirmDialogProvider>
      <DevicePanel
        trpc={fakeTrpc({ getCcuDeviceState: () => STATE, ...handlers })}
        integrationId="hm_1"
        address={ADDRESS}
        deviceId={42}
      />
    </ConfirmDialogProvider>,
  )
}

function row(parameter: string): HTMLElement {
  const cell = screen.getByText(parameter)
  const tr = cell.closest('tr')
  if (tr === null) throw new Error(`no row for ${parameter}`)
  return tr
}

afterEach(() => cleanup())

describe('DevicePanel', () => {
  it('shows the maintenance readings and the firmware update', async () => {
    mount({})
    const badges = await screen.findByTestId('hm-panel-diagnostics')
    expect(within(badges).getByText('Reachable')).toBeTruthy()
    expect(within(badges).getByText('Low battery')).toBeTruthy()
    expect(within(badges).getByText('RSSI -64 / -71 dBm')).toBeTruthy()
    expect(within(badges).getByText('Update available: 1.6.2')).toBeTruthy()
    expect(within(badges).queryByText('Configuration pending')).toBeNull()
  })

  it('offers no write on a read-only value and shows an enum by its label', async () => {
    mount({})
    await screen.findByText('PROCESS')
    expect(within(row('PROCESS')).queryByRole('button')).toBeNull()
    expect(within(row('PROCESS')).getByText('STABLE')).toBeTruthy()
  })

  it('switches a channel off only after the operator confirms', async () => {
    const setValue = vi.fn((_input: Record<string, unknown>) => ({ ok: true }))
    mount({ setCcuValue: setValue })
    await screen.findByText('STATE')
    fireEvent.click(within(row('STATE')).getByRole('button', { name: 'Turn off' }))
    const dialog = await screen.findByRole('dialog', { name: /Change a value on the CCU/ })
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(setValue).not.toHaveBeenCalled()

    fireEvent.click(within(row('STATE')).getByRole('button', { name: 'Turn off' }))
    const again = await screen.findByRole('dialog', { name: /Change a value on the CCU/ })
    fireEvent.click(within(again).getByRole('button', { name: 'Send to the CCU' }))
    await waitFor(() => expect(setValue).toHaveBeenCalledTimes(1))
    expect(setValue.mock.calls[0]?.[0]).toEqual({
      integrationId: 'hm_1',
      channel: `${ADDRESS}:4`,
      parameter: 'STATE',
      value: false,
      deviceId: 42,
      confirmed: true,
    })
  })

  it('presses a key with true', async () => {
    const setValue = vi.fn((_input: Record<string, unknown>) => ({ ok: true }))
    mount({ setCcuValue: setValue })
    await screen.findByText('PRESS_SHORT')
    fireEvent.click(within(row('PRESS_SHORT')).getByRole('button', { name: 'Press' }))
    const dialog = await screen.findByRole('dialog', { name: /Change a value on the CCU/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send to the CCU' }))
    await waitFor(() => expect(setValue).toHaveBeenCalledTimes(1))
    expect(setValue.mock.calls[0]?.[0]).toMatchObject({ parameter: 'PRESS_SHORT', value: true })
  })

  it('sets a number through its typed field', async () => {
    const setValue = vi.fn((_input: Record<string, unknown>) => ({ ok: true }))
    mount({ setCcuValue: setValue })
    await screen.findByText('ON_TIME')
    fireEvent.click(within(row('ON_TIME')).getByRole('button', { name: 'Set…' }))
    const form = await screen.findByTestId('hm-set-value-dialog')
    fireEvent.change(within(form).getByRole('spinbutton'), { target: { value: '30' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Send' }))
    const confirm = await screen.findByRole('dialog', { name: /Change a value on the CCU/ })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send to the CCU' }))
    await waitFor(() => expect(setValue).toHaveBeenCalledTimes(1))
    expect(setValue.mock.calls[0]?.[0]).toMatchObject({ parameter: 'ON_TIME', value: 30 })
  })
})

describe('value-format', () => {
  const level = param({
    parameter: 'COLOR',
    type: 'ENUM',
    valueList: ['BLACK', 'BLUE', 'GREEN'],
    value: 1,
    writable: true,
  })

  it('edits an enum by its label and sends its index back', () => {
    expect(asEditable(level).value).toBe('BLUE')
    expect(parseValueEdit(level, 'GREEN')).toBe(2)
    expect(parseValueEdit(level, 'PURPLE')).toBeUndefined()
  })

  it('reads a write-only value as nothing, and a number with its unit', () => {
    expect(
      valueText(param({ parameter: 'PRESS_SHORT', type: 'ACTION', readable: false, value: true })),
    ).toBeNull()
    expect(valueText(param({ parameter: 'ON_TIME', unit: 's', value: 30 }))).toBe('30 s')
  })
})
