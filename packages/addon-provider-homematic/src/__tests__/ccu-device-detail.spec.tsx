/** @vitest-environment jsdom */

import { ConfirmDialogProvider } from '@dominevo/ui-library'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HomematicCcuPage from '../page.js'
import type { CcuTrpc } from '../ui/ccu-client.js'

type Handler = (input: Record<string, unknown>) => unknown

function fakeTrpc(handlers: Record<string, Handler>): CcuTrpc {
  return {
    addons: {
      custom: {
        mutate: async ({ action, input }) => {
          const asRecord: Record<string, unknown> =
            typeof input === 'object' && input !== null ? { ...input } : {}
          const handler = handlers[action]
          if (handler === undefined) throw new Error(`unexpected action ${action}`)
          return handler(asRecord)
        },
      },
    },
  }
}

// Documented type boundary: the fake implements the one call the page makes (`addons.custom`).
function mountPage(trpc: CcuTrpc, navigate: (path: string) => void = () => undefined) {
  return render(
    <ConfirmDialogProvider>
      <HomematicCcuPage trpc={trpc as never} theme={{ isDark: true }} navigate={navigate} />
    </ConfirmDialogProvider>,
  )
}

afterEach(() => cleanup())

const BUTTON = {
  address: 'BTN1',
  type: 'HmIP-BS2',
  name: 'Hall buttons',
  rooms: ['Hall'],
  functions: ['Light'],
  firmware: '1.0.6',
  availableFirmware: null,
  updatable: false,
  rssi: -60,
  rssiPeer: null,
  dutyCycle: null,
  dutyCycleLimited: null,
  lowBattery: false,
  unreach: false,
  configPending: false,
  sabotage: false,
  deviceId: 42,
  keyChannels: [
    { address: 'BTN1:1', index: '1', name: 'Left', central: 'off', links: [] },
    { address: 'BTN1:2', index: '2', name: 'Right', central: 'on', links: [] },
  ],
}
const PLAIN = {
  ...BUTTON,
  address: 'PLN1',
  name: 'Plain radiator',
  deviceId: null,
  keyChannels: [],
}

const programChannel = (address: string) => ({
  address,
  channelName: null,
  deviceName: 'Hall buttons',
  deviceId: 42,
})

const HANDLERS: Record<string, Handler> = {
  listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: true }],
  listCcuDevices: () => ({ devices: [BUTTON, PLAIN] }),
  listCcuPrograms: () => ({
    programs: [
      {
        id: 'p1',
        name: 'Dominevo: Hall events',
        active: true,
        internal: false,
        lastRunMs: null,
        createdByCamstack: true,
        channels: [programChannel('BTN1:1')],
      },
    ],
    keys: [],
  }),
  getCcuDeviceState: () => ({
    address: 'BTN1',
    name: 'Hall buttons',
    type: 'HmIP-BS2',
    firmware: { installed: '1.0.6', available: null, updatable: false, state: null },
    diagnostics: {
      rssiDevice: -60,
      rssiPeer: null,
      unreach: false,
      lowBattery: false,
      dutyCycle: false,
      configPending: false,
    },
    channels: [],
  }),
  listHeatingGroups: () => ({ groups: [], groupsError: null, thermostats: [], candidates: [] }),
  listCcuLinks: () => ({ links: [], senders: [], receivers: [], failures: [] }),
  listServiceMessages: () => ({ messages: [], error: null }),
  listCcuFaults: () => ({ faults: [], unreported: [] }),
}

function mountAt(
  search: string,
  handlers: Record<string, Handler> = HANDLERS,
  navigate?: () => void,
) {
  window.history.replaceState(null, '', `/${search}`)
  return mountPage(fakeTrpc(handlers), navigate)
}

describe('device detail URL', () => {
  it('reopens the device named in ?device= (a reload or a shared link)', async () => {
    mountAt('?tab=devices&device=BTN1')
    expect(await screen.findByTestId('hm-device-detail')).toBeTruthy()
    expect(screen.getByText('Identity')).toBeTruthy()
    expect(screen.getByText('HmIP-RF')).toBeTruthy()
  })

  it('opens from a table row and writes the address to the URL', async () => {
    mountAt('?tab=devices')
    fireEvent.click(await screen.findByText('Plain radiator'))
    expect(await screen.findByTestId('hm-device-detail')).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('device')).toBe('PLN1')
  })

  it('goes back to the table and drops ?device=', async () => {
    mountAt('?tab=devices&device=BTN1')
    fireEvent.click(await screen.findByRole('button', { name: 'Back to devices' }))
    await waitFor(() => expect(screen.queryByTestId('hm-device-detail')).toBeNull())
    expect(new URLSearchParams(window.location.search).get('device')).toBeNull()
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('devices')
  })

  it('says a linked device is not on the CCU instead of showing the table silently', async () => {
    mountAt('?tab=devices&device=GONE')
    expect(await screen.findByText('Device GONE is not on this CCU.')).toBeTruthy()
  })
})

describe('the Devices table no longer carries the event quick actions', () => {
  it('has no button-events action in the row menu', async () => {
    mountAt('?tab=devices')
    await screen.findByText('Hall buttons')
    const menus = screen.getAllByRole('button', { name: /More actions/ })
    fireEvent.click(menus[0] as HTMLElement)
    expect(screen.queryByRole('button', { name: /button events/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Rename on the CCU' })).toBeTruthy()
  })

  it('offers them in the detail instead', async () => {
    mountAt('?tab=devices&device=BTN1')
    expect(await screen.findByRole('button', { name: 'Central link' })).toBeTruthy()
  })
})

describe('faults in the detail', () => {
  it('says "not reported" for an unreported device, never "no faults"', async () => {
    mountAt('?tab=devices&device=BTN1', {
      ...HANDLERS,
      listCcuFaults: () => ({ faults: [], unreported: ['BTN1'] }),
    })
    expect(
      await screen.findByText("The CCU has not reported this device's service flags yet"),
    ).toBeTruthy()
    expect(screen.queryByText('No active faults or service messages')).toBeNull()
  })

  it('does not claim "no faults" beside a service-messages warning', async () => {
    const faultsRead = vi.fn(() => ({ faults: [], unreported: [] }))
    mountAt('?tab=devices&device=BTN1', {
      ...HANDLERS,
      listCcuFaults: faultsRead,
      listServiceMessages: () => ({ messages: [], error: 'CCU did not answer' }),
    })
    expect(await screen.findByText('CCU did not answer')).toBeTruthy()
    await waitFor(() => expect(faultsRead).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText('No active faults or service messages')).toBeNull()
  })
})

describe('dummy programs', () => {
  it('names the program per key in the detail and flags the key without one', async () => {
    mountAt('?tab=devices&device=BTN1')
    const detail = await screen.findByTestId('hm-device-detail')
    expect(await within(detail).findByText('Dominevo: Hall events')).toBeTruthy()
    expect(within(detail).getByTestId('hm-key-event-ok')).toBeTruthy()
    expect(within(detail).getByTestId('hm-key-event-missing')).toBeTruthy()
    expect(within(detail).getByRole('button', { name: 'Create event program' })).toBeTruthy()
  })

  it('shows "events" in the table for devices with keys only', async () => {
    mountAt('?tab=devices')
    await screen.findByText('Hall buttons')
    expect(await screen.findByText('Events: no program')).toBeTruthy()
  })

  it('does not claim a missing program when the programs could not be read', async () => {
    mountAt('?tab=devices', {
      ...HANDLERS,
      listCcuPrograms: () => {
        throw new Error('ReGa down')
      },
    })
    await screen.findByText('Hall buttons')
    expect(await screen.findByText('Events: unknown')).toBeTruthy()
    expect(screen.queryByText('Events: no program')).toBeNull()
  })
})

describe('Active faults on the Overview', () => {
  const OVERVIEW = {
    info: null,
    infoError: 'none',
    interfaces: [],
    interfacesError: null,
  }
  const base: Record<string, Handler> = {
    ...HANDLERS,
    ccuOverview: () => OVERVIEW,
  }

  it('lists a device per row, links to its detail URL', async () => {
    const navigate = vi.fn()
    mountAt(
      '',
      {
        ...base,
        listCcuFaults: () => ({
          faults: [
            {
              address: 'BTN1',
              name: 'Hall buttons',
              deviceId: 42,
              severity: 'error',
              code: 'UNREACH',
              label: 'Device unreachable',
              since: null,
              faults: [{ code: 'UNREACH', label: 'Device unreachable', severity: 'error' }],
            },
          ],
          unreported: [],
        }),
      },
      navigate,
    )
    expect(await screen.findByText('Device unreachable')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Hall buttons' })
    fireEvent.click(link)
    const target = new URL(String(navigate.mock.calls[0]?.[0]), 'http://hub')
    expect(target.searchParams.get('device')).toBe('BTN1')
    expect(target.searchParams.get('tab')).toBe('devices')
  })

  it('shows the warning alert when the faults read fails, never an empty list', async () => {
    mountAt('', {
      ...base,
      listCcuFaults: () => {
        throw new Error('CCU did not answer')
      },
    })
    expect(await screen.findByText('Active faults unavailable')).toBeTruthy()
    expect(screen.getByText('CCU did not answer')).toBeTruthy()
    expect(screen.queryByText('No active faults')).toBeNull()
  })

  it('names how many devices have not reported, instead of calling them healthy', async () => {
    mountAt('', { ...base, listCcuFaults: () => ({ faults: [], unreported: ['BTN1', 'PLN1'] }) })
    expect(
      await screen.findByText(
        '2 devices have not reported their service flags yet, so their state is unknown',
      ),
    ).toBeTruthy()
  })

  it('says "No active faults" only from an answer with none', async () => {
    mountAt('', {
      ...base,
      listCcuFaults: () => ({ faults: [], unreported: [], gatewayFaults: [] }),
    })
    expect(await screen.findByText('No active faults')).toBeTruthy()
  })

  it('says the gateway status is unknown, never "No active faults", when it was never read', async () => {
    mountAt('', {
      ...base,
      listCcuFaults: () => ({ faults: [], unreported: [], gatewayFaults: null }),
    })
    expect(await screen.findByText('The gateway status is not known yet.')).toBeTruthy()
    expect(screen.queryByText('No active faults')).toBeNull()
  })

  it('lists a gateway fault beside the device table', async () => {
    mountAt('', {
      ...base,
      listCcuFaults: () => ({
        faults: [],
        unreported: [],
        gatewayFaults: [
          { code: 'radio-silent', label: 'No radio events received', severity: 'error' },
        ],
      }),
    })
    expect(await screen.findByText('No radio events received')).toBeTruthy()
    expect(screen.queryByText('No active faults')).toBeNull()
  })
})
