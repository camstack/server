/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import HomematicCcuPage from '../page.js'
import type { CcuTrpc } from '../ui/ccu-client.js'

type Handler = (input: Record<string, unknown>) => unknown

function fakeTrpc(handlers: Record<string, Handler>) {
  const calls: { action: string; input: Record<string, unknown> }[] = []
  const trpc: CcuTrpc = {
    addons: {
      custom: {
        mutate: async ({ action, input }) => {
          const asRecord: Record<string, unknown> =
            typeof input === 'object' && input !== null ? { ...input } : {}
          calls.push({ action, input: asRecord })
          const handler = handlers[action]
          if (handler === undefined) throw new Error(`unexpected action ${action}`)
          return handler(asRecord)
        },
      },
    },
  }
  return { trpc, calls }
}

const IFACE = {
  name: 'HmIP-RF',
  port: 2010,
  info: null,
  connected: true,
  dutyCycle: 12,
  firmware: '2.8.6',
  type: 'HmIP',
  gateways: [],
}
const OVERVIEW = {
  info: {
    version: '3.75.7',
    product: 'raspberrymatic',
    productFamily: 'openccu',
    platform: 'rpi4',
    serial: 'SER1',
    hostname: 'homematic',
  },
  infoError: null,
  interfaces: [IFACE],
  interfacesError: null,
}
const MESSAGE = {
  id: 'm1',
  name: 'Hall lamp',
  address: 'ABC',
  channel: 0,
  type: 'STICKY_UNREACH',
  timestamp: 1_700_000_000_000,
  acknowledgeable: true,
}

// Documented type boundary: the fake implements the one call the page makes (`addons.custom`).
function mountPage(trpc: CcuTrpc) {
  return render(
    <ConfirmDialogProvider>
      <HomematicCcuPage trpc={trpc as never} theme={{ isDark: true }} navigate={() => undefined} />
    </ConfirmDialogProvider>,
  )
}

afterEach(() => cleanup())

describe('HomematicCcuPage overview', () => {
  const base = {
    listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: true }],
    ccuOverview: () => OVERVIEW,
    listServiceMessages: () => ({ messages: [MESSAGE], error: null }),
  }

  it('shows the CCU, its interface health and the service messages', async () => {
    const { trpc } = fakeTrpc(base)
    mountPage(trpc)
    expect(await screen.findByText('3.75.7')).toBeTruthy()
    expect(screen.getByText('HmIP-RF')).toBeTruthy()
    expect(screen.getByText('12%')).toBeTruthy()
    expect(await screen.findByText('STICKY_UNREACH')).toBeTruthy()
  })

  it('says why the CCU details are missing instead of showing blanks', async () => {
    const { trpc } = fakeTrpc({
      ...base,
      ccuOverview: () => ({ ...OVERVIEW, info: null, infoError: 'needs WebUI credentials' }),
    })
    mountPage(trpc)
    expect(await screen.findByText('needs WebUI credentials')).toBeTruthy()
    expect(screen.getByText('HmIP-RF')).toBeTruthy()
  })

  it('renders a disconnected CCU as not connected, not as empty', async () => {
    const { trpc, calls } = fakeTrpc({
      ...base,
      listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: false }],
    })
    mountPage(trpc)
    expect(await screen.findByText('Casa is not connected')).toBeTruthy()
    expect(calls.some((c) => c.action === 'ccuOverview')).toBe(false)
  })

  it('does not acknowledge when the operator declines the dialog', async () => {
    const { trpc, calls } = fakeTrpc({ ...base, acknowledgeServiceMessage: () => ({ ok: true }) })
    mountPage(trpc)
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.some((c) => c.action === 'acknowledgeServiceMessage')).toBe(false)
  })

  it('acknowledges only after confirmation, sending confirmed: true', async () => {
    const ack = vi.fn().mockReturnValue({ ok: true })
    const { trpc, calls } = fakeTrpc({ ...base, acknowledgeServiceMessage: ack })
    mountPage(trpc)
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(ack).toHaveBeenCalled())
    expect(ack.mock.calls[0]?.[0]).toEqual({ integrationId: 'hm_1', id: 'm1', confirmed: true })
    await waitFor(() =>
      expect(calls.filter((c) => c.action === 'listServiceMessages').length).toBe(2),
    )
  })
})

describe('HomematicCcuPage devices', () => {
  const DEVICE = {
    address: 'ABC',
    type: 'HmIP-eTRV-2',
    name: 'Bedroom radiator',
    rooms: ['Bedroom'],
    functions: ['Heating'],
    firmware: '1.0.6',
    availableFirmware: '1.0.8',
    updatable: true,
    rssi: -61,
    rssiPeer: null,
    dutyCycle: null,
    dutyCycleLimited: null,
    lowBattery: true,
    unreach: false,
    configPending: false,
    sabotage: false,
  }
  const OK_DEVICE = { ...DEVICE, address: 'DEF', name: 'Hall lamp', lowBattery: false }

  function mountDevices(devices: unknown[]) {
    window.history.replaceState(null, '', '/?tab=devices')
    const { trpc, calls } = fakeTrpc({
      listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: true }],
      listCcuDevices: () => ({ devices }),
    })
    mountPage(trpc)
    return calls
  }

  it('lists devices with firmware, signal and health flags', async () => {
    mountDevices([DEVICE])
    expect(await screen.findByText('Bedroom radiator')).toBeTruthy()
    expect(screen.getByText('-61 dBm')).toBeTruthy()
    expect(screen.getByText('Low battery')).toBeTruthy()
    expect(screen.getByText('Update to 1.0.8')).toBeTruthy()
  })

  it('filters to the devices with a health issue', async () => {
    mountDevices([DEVICE, OK_DEVICE])
    expect(await screen.findByText('Hall lamp')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Low battery/ }))
    await waitFor(() => expect(screen.queryByText('Hall lamp')).toBeNull())
    expect(screen.getByText('Bedroom radiator')).toBeTruthy()
  })

  it('says the CCU has no devices instead of showing an empty grid', async () => {
    mountDevices([])
    expect(await screen.findByText('The CCU has no devices')).toBeTruthy()
  })
})

describe('HomematicCcuPage heating', () => {
  const GROUP = {
    id: 7,
    name: 'Bedroom',
    type: 'hmip.heating.group',
    typeLabel: 'Heating group',
    deviceAddress: 'INT0000001',
    forbidSingleOperation: false,
    members: [
      { address: 'TRV1:1', type: 'HEATING_CLIMATECONTROL_TRANSCEIVER', deviceName: 'Radiator' },
    ],
  }
  const OVERVIEW_H = {
    groups: [GROUP],
    groupsError: null,
    thermostats: [
      {
        device: 'TRV1',
        channel: 'TRV1:1',
        name: 'Radiator',
        currentTemperature: 19.5,
        targetTemperature: 21,
        mode: 'auto',
        activity: 'heating',
      },
    ],
    candidates: [
      { address: 'TRV1:1', type: 'HEATING_CLIMATECONTROL_TRANSCEIVER', deviceName: 'Radiator' },
      {
        address: 'TRV2:1',
        type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        deviceName: 'Study radiator',
      },
    ],
  }

  function mountHeating(extra: Record<string, Handler>, overview: unknown = OVERVIEW_H) {
    window.history.replaceState(null, '', '/?tab=heating')
    const fake = fakeTrpc({
      listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: true }],
      listHeatingGroups: () => overview,
      ...extra,
    })
    mountPage(fake.trpc)
    return fake.calls
  }

  it('shows groups with their members and the thermostats', async () => {
    mountHeating({})
    expect(await screen.findByText('Bedroom')).toBeTruthy()
    expect(screen.getAllByText('Radiator').length).toBeGreaterThan(0)
    expect(screen.getByText('19.5 °C')).toBeTruthy()
  })

  it('explains why groups are missing and disables creating one', async () => {
    mountHeating({}, { ...OVERVIEW_H, groups: [], groupsError: 'needs WebUI credentials' })
    expect(await screen.findByText('needs WebUI credentials')).toBeTruthy()
    expect((screen.getByRole('button', { name: /New group/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('creates a group only after the operator confirms, sending the picked members', async () => {
    const create = vi.fn().mockReturnValue(GROUP)
    const calls = mountHeating({ createHeatingGroup: create })
    const newGroup = await screen.findByRole('button', { name: /New group/ })
    await waitFor(() => expect((newGroup as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(newGroup)
    const form = await screen.findByTestId('hm-group-dialog')
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'Study' } })
    fireEvent.click(within(form).getByLabelText(/Study radiator/))
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(create).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: /Create heating group/ })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0]?.[0]).toEqual({
      integrationId: 'hm_1',
      name: 'Study',
      type: 'hmip.heating.group',
      members: ['TRV2:1'],
      confirmed: true,
    })
    await waitFor(() =>
      expect(calls.filter((c) => c.action === 'listHeatingGroups').length).toBe(2),
    )
  })

  it('deletes a group only after the operator confirms', async () => {
    const del = vi.fn().mockReturnValue({ ok: true })
    mountHeating({ deleteHeatingGroup: del })
    fireEvent.click(await screen.findByRole('button', { name: /More actions/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const confirm = await screen.findByRole('dialog', { name: /Delete heating group/ })
    expect(del).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete group' }))
    await waitFor(() => expect(del).toHaveBeenCalled())
    expect(del.mock.calls[0]?.[0]).toEqual({ integrationId: 'hm_1', id: 7, confirmed: true })
  })

  it('shows the CCU refusal when a write fails', async () => {
    const del = vi.fn().mockImplementation(() => {
      throw new Error('GroupWriteVerificationError: still present')
    })
    mountHeating({ deleteHeatingGroup: del })
    fireEvent.click(await screen.findByRole('button', { name: /More actions/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const confirm = await screen.findByRole('dialog', { name: /Delete heating group/ })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete group' }))
    expect(await screen.findByText(/still present/)).toBeTruthy()
  })
})

describe('HomematicCcuPage pairing', () => {
  const STATUS_CLOSED = {
    interfaces: [
      { name: 'BidCos-RF', secondsLeft: 0, supportsSecure: true, error: null },
      { name: 'HmIP-RF', secondsLeft: null, supportsSecure: false, error: null },
    ],
    error: null,
  }
  const EXISTING = {
    address: 'OLD',
    type: 'HmIP-eTRV-2',
    name: 'Old radiator',
    rooms: [],
    functions: [],
    firmware: null,
    availableFirmware: null,
    updatable: null,
    rssi: null,
    rssiPeer: null,
    dutyCycle: null,
    dutyCycleLimited: null,
    lowBattery: null,
    unreach: null,
    configPending: null,
    sabotage: null,
  }

  function mountPairing(extra: Record<string, Handler>, status: unknown = STATUS_CLOSED) {
    window.history.replaceState(null, '', '/?tab=pairing')
    const fake = fakeTrpc({
      listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: true }],
      ccuPairingStatus: () => status,
      listCcuDevices: () => ({ devices: [EXISTING] }),
      ...extra,
    })
    mountPage(fake.trpc)
    return fake.calls
  }

  it('shows each radio interface with its window state, unknown as unknown', async () => {
    mountPairing({})
    const bidcos = await screen.findByTestId('hm-pairing-BidCos-RF')
    expect(within(bidcos).getByRole('button', { name: 'Start pairing' })).toBeTruthy()
    expect(screen.getByText('Closed')).toBeTruthy()
    expect(screen.getByText('Unknown')).toBeTruthy()
    expect(screen.getByText(/entering a device key or SGTIN is not offered/)).toBeTruthy()
  })

  it('opens the window only after the operator confirms, with seconds and mode', async () => {
    const setMode = vi.fn().mockReturnValue({ ok: true })
    mountPairing({ setCcuInstallMode: setMode })
    const bidcos = await screen.findByTestId('hm-pairing-BidCos-RF')
    fireEvent.change(within(bidcos).getByRole('spinbutton'), { target: { value: '90' } })
    fireEvent.change(within(bidcos).getByRole('combobox'), { target: { value: 'secure' } })
    fireEvent.click(within(bidcos).getByRole('button', { name: 'Start pairing' }))
    expect(setMode).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: /Open the BidCos-RF pairing window/ })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Start pairing' }))
    await waitFor(() => expect(setMode).toHaveBeenCalled())
    expect(setMode.mock.calls[0]?.[0]).toEqual({
      integrationId: 'hm_1',
      interface: 'BidCos-RF',
      on: true,
      seconds: 90,
      mode: 'secure',
      confirmed: true,
    })
  })

  it('lists a device that appeared on the CCU after the tab opened', async () => {
    let devices: unknown[] = [EXISTING]
    mountPairing(
      { listCcuDevices: () => ({ devices }) },
      {
        interfaces: [{ name: 'HmIP-RF', secondsLeft: 30, supportsSecure: false, error: null }],
        error: null,
      },
    )
    await screen.findByText('Open, 30 s left')
    expect(await screen.findByText('Waiting for a device to pair...')).toBeTruthy()
    devices = [EXISTING, { ...EXISTING, address: 'NEW1', name: 'New thermostat' }]
    expect(await screen.findByText('New thermostat', {}, { timeout: 8000 })).toBeTruthy()
    expect(screen.queryByText('Old radiator')).toBeNull()
  }, 15000)

  it('says why the interfaces are missing instead of showing none', async () => {
    mountPairing({}, { interfaces: [], error: 'no credentials' })
    expect(await screen.findByText('no credentials')).toBeTruthy()
  })
})

describe('HomematicCcuPage device delete', () => {
  const DEV = {
    address: 'ABC',
    type: 'HmIP-eTRV-2',
    name: 'Bedroom radiator',
    rooms: [],
    functions: [],
    firmware: null,
    availableFirmware: null,
    updatable: null,
    rssi: null,
    rssiPeer: null,
    dutyCycle: null,
    dutyCycleLimited: null,
    lowBattery: null,
    unreach: null,
    configPending: null,
    sabotage: null,
  }

  it('deletes only after the dialog and the confirmation, with the factory-reset flag', async () => {
    window.history.replaceState(null, '', '/?tab=devices')
    const del = vi.fn().mockReturnValue({ ok: true })
    const fake = fakeTrpc({
      listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: true }],
      listCcuDevices: () => ({ devices: [DEV] }),
      deleteCcuDevice: del,
    })
    mountPage(fake.trpc)
    fireEvent.click(await screen.findByRole('button', { name: /More actions/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete from CCU' }))
    const form = await screen.findByTestId('hm-delete-device-dialog')
    fireEvent.click(within(form).getByLabelText('Factory-reset the device'))
    fireEvent.click(within(form).getByRole('button', { name: 'Continue' }))
    expect(del).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: /Delete device from the CCU/ })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete device' }))
    await waitFor(() => expect(del).toHaveBeenCalled())
    expect(del.mock.calls[0]?.[0]).toEqual({
      integrationId: 'hm_1',
      address: 'ABC',
      reset: true,
      force: false,
      confirmed: true,
    })
  })
})

describe('HomematicCcuPage device configuration', () => {
  const DEV = {
    address: 'ABC',
    type: 'HmIP-eTRV-2',
    name: 'Bedroom radiator',
    rooms: [],
    functions: [],
    firmware: null,
    availableFirmware: null,
    updatable: null,
    rssi: null,
    rssiPeer: null,
    dutyCycle: null,
    dutyCycleLimited: null,
    lowBattery: null,
    unreach: null,
    configPending: null,
    sabotage: null,
  }
  const CONFIG = {
    channels: [
      {
        channel: 'ABC:1',
        channelType: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        error: null,
        params: [
          {
            parameter: 'TEMPERATURE_OFFSET',
            type: 'FLOAT',
            min: -3.5,
            max: 3.5,
            unit: '°C',
            valueList: null,
            writable: true,
            value: 0.5,
          },
          {
            parameter: 'FIRMWARE',
            type: 'STRING',
            min: null,
            max: null,
            unit: null,
            valueList: null,
            writable: false,
            value: '1.0',
          },
        ],
      },
    ],
  }

  it('sends only the changed parameter, and only after the operator confirms', async () => {
    window.history.replaceState(null, '', '/?tab=devices')
    const setCfg = vi.fn().mockReturnValue({ ok: true })
    const fake = fakeTrpc({
      listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: true }],
      listCcuDevices: () => ({ devices: [DEV] }),
      getCcuDeviceConfig: () => CONFIG,
      setCcuChannelConfig: setCfg,
    })
    mountPage(fake.trpc)
    fireEvent.click(await screen.findByRole('button', { name: /More actions/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }))
    const form = await screen.findByTestId('hm-config-dialog')
    const save = await within(form).findByRole('button', { name: 'Save changes' })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    const offset = await within(form).findByDisplayValue('0.5')
    fireEvent.change(offset, { target: { value: '1.5' } })
    expect((within(form).getByDisplayValue('1.0') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(save)
    expect(setCfg).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: /Write device configuration/ })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Write configuration' }))
    await waitFor(() => expect(setCfg).toHaveBeenCalled())
    expect(setCfg.mock.calls[0]?.[0]).toEqual({
      integrationId: 'hm_1',
      channel: 'ABC:1',
      values: { TEMPERATURE_OFFSET: 1.5 },
      confirmed: true,
    })
  })
})
