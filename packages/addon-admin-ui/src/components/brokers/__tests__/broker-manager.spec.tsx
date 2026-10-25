/**
 * BrokerManager — id-keyed calls must carry the owning broker's
 * `addonId` so they route to the provider that owns the broker (not the
 * first-registered one). This spec mocks the broker hooks and asserts:
 *  - the table renders a broker tagged with its `addonId`,
 *  - Test connection passes `{ id, addonId }`,
 *  - Delete passes `{ id, addonId }`,
 *  - the Add picker is sourced from `listProviders()` (live addonId data).
 *
 * Partial-mock of `@camstack/ui-library`: only the broker + confirm hooks
 * are stubbed; everything else keeps its real implementation.
 */
import type { ReactElement } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const mockTest = vi.fn()
const mockRemove = vi.fn()
const mockAdd = vi.fn()
const mockConfirm = vi.fn(async () => true)

const HA_BROKER = {
  id: 'ha_1',
  addonId: 'provider-homeassistant',
  name: 'Casa',
  kind: 'home-assistant',
  status: 'connected',
  info: {},
  lastCheckedAt: null,
  error: null,
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useBrokerList: () => ({ data: [HA_BROKER], isLoading: false, isError: false }),
    useBrokerListProviders: () => ({
      data: [
        { addonId: 'mqtt-broker', kinds: [{ kind: 'mqtt', label: 'MQTT' }] },
        {
          addonId: 'provider-homeassistant',
          kinds: [{ kind: 'home-assistant', label: 'Home Assistant' }],
        },
      ],
    }),
    useBrokerGetSettings: () => ({ data: {}, isLoading: false, isError: false }),
    useBrokerAdd: () => ({ mutate: mockAdd, isPending: false, isError: false }),
    useBrokerSetSettings: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
    useBrokerTestConnection: () => ({ mutate: mockTest, isPending: false }),
    useBrokerRemove: () => ({ mutate: mockRemove, isPending: false }),
    useConfirm: () => mockConfirm,
    // Drive the embedded BrokerForm: a minimal one-field schema so the
    // form renders + can submit, and a no-op test-settings mutation.
    useBrokerGetSettingsSchema: () => ({
      data: {
        sections: [
          {
            id: 'conn',
            title: 'Conn',
            columns: 1,
            fields: [{ type: 'text', key: 'host', label: 'Host', placeholder: 'broker host' }],
          },
        ],
      },
      isLoading: false,
      isError: false,
    }),
    useBrokerTestSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

import { BrokerManager } from '../BrokerManager'

describe('BrokerManager — addonId ownership routing', () => {
  beforeEach(() => {
    mockTest.mockClear()
    mockRemove.mockClear()
    mockAdd.mockClear()
    mockConfirm.mockClear()
  })

  it('renders the HA broker row', () => {
    renderWithClient(<BrokerManager />)
    expect(screen.getByText('Casa')).toBeTruthy()
  })

  it('Test connection passes the owning addonId selector', () => {
    renderWithClient(<BrokerManager />)
    fireEvent.click(screen.getByRole('button', { name: /test/i }))
    expect(mockTest).toHaveBeenCalledTimes(1)
    expect(mockTest).toHaveBeenCalledWith({ id: 'ha_1', addonId: 'provider-homeassistant' })
  })

  it('Delete passes the owning addonId selector', async () => {
    renderWithClient(<BrokerManager />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(1))
    expect(mockRemove).toHaveBeenCalledWith({ id: 'ha_1', addonId: 'provider-homeassistant' })
  })

  it('Add flow threads the selected provider addonId + kind into the add call', async () => {
    renderWithClient(<BrokerManager />)

    // Open the Add dialog.
    fireEvent.click(screen.getByRole('button', { name: /add broker/i }))

    // Kind picker is sourced from listProviders() — pick the MQTT provider.
    // Options are keyed `${addonId}::${kind}`.
    const kindSelect = await screen.findByRole('combobox')
    fireEvent.change(kindSelect, { target: { value: 'mqtt-broker::mqtt' } })

    // Fill the broker name (collected by the Add dialog itself).
    fireEvent.change(screen.getByPlaceholderText('My Home Assistant'), {
      target: { value: 'My MQTT' },
    })

    // Fill the embedded BrokerForm's single schema field, then submit.
    fireEvent.change(screen.getByPlaceholderText('broker host'), {
      target: { value: 'mqtt.local' },
    })

    // Two buttons read "Add broker": the manager's launcher and the
    // BrokerForm's submit. The form's submit is the last one (inside the
    // dialog) — drive that to actually fire the add mutation.
    const addButtons = screen.getAllByRole('button', { name: /add broker/i })
    fireEvent.click(addButtons[addButtons.length - 1])

    await waitFor(() => expect(mockAdd).toHaveBeenCalledTimes(1))
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mqtt',
        name: 'My MQTT',
        addonId: 'mqtt-broker',
        settings: expect.objectContaining({ host: 'mqtt.local' }),
      }),
    )
  })

  it('refuses to add a nameless broker and says why', async () => {
    renderWithClient(<BrokerManager />)
    fireEvent.click(screen.getByRole('button', { name: /add broker/i }))
    fireEvent.change(await screen.findByPlaceholderText('broker host'), {
      target: { value: 'mqtt.local' },
    })
    const addButtons = screen.getAllByRole('button', { name: /add broker/i })
    fireEvent.click(addButtons[addButtons.length - 1])
    expect(await screen.findByText('Enter a name before saving.')).toBeTruthy()
    expect(mockAdd).not.toHaveBeenCalled()
  })
})

describe('BrokerManager — scoped to one provider', () => {
  it('lists only the connections the provider owns', () => {
    renderWithClient(<BrokerManager addonId="mqtt-broker" />)
    expect(screen.queryByText('Casa')).toBeNull()
    expect(screen.getByText(/No brokers registered yet/)).toBeTruthy()
  })

  it('offers only the kinds the provider serves', async () => {
    renderWithClient(<BrokerManager addonId="provider-homeassistant" />)
    expect(screen.getByText('Casa')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /add broker/i }))
    const kindSelect = (await screen.findByRole('combobox')) as HTMLSelectElement
    // The form builder's select carries an empty "choose…" option of its own.
    expect([...kindSelect.options].map((o) => o.value).filter((v) => v !== '')).toEqual([
      'provider-homeassistant::home-assistant',
    ])
  })
})
