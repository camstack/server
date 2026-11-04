/**
 * BrokerStep — the integration wizard's broker gate. It is a `BrokerPicker`
 * plus a confirm button: pick a broker of the required kind, or "Create new…"
 * (the shared dialog, stacked over the wizard) and come back with it selected.
 * Either way the step resolves to one `brokerId`. The create / sign-in
 * behaviour itself is pinned in `brokers/__tests__/broker-editor-flow.spec.tsx`.
 */
import { describe, it, expect, vi } from 'vitest'
import '../../brokers/__tests__/setup'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockAdd = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const brokers = [
    {
      id: 'ha_001',
      addonId: 'provider-homeassistant',
      name: 'Home',
      kind: 'home-assistant',
      status: 'connected',
    },
    {
      id: 'mqtt_001',
      addonId: 'mqtt-broker',
      name: 'Mosquitto',
      kind: 'mqtt',
      status: 'connected',
    },
  ]
  return {
    ...actual,
    useBrokerList: (input: { kind?: string }) => ({
      data: brokers.filter((b) => input.kind === undefined || b.kind === input.kind),
      isLoading: false,
    }),
    useBrokerListProviders: () => ({
      data: [
        {
          addonId: 'provider-homeassistant',
          kinds: [{ kind: 'home-assistant', label: 'Home Assistant' }],
        },
        { addonId: 'mqtt-broker', kinds: [{ kind: 'mqtt', label: 'MQTT' }] },
      ],
    }),
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          describe: {
            query: async () => ({
              instanceMode: 'multiple',
              kind: 'connection',
              canTest: false,
              mintsId: true,
              kinds: [{ id: 'home-assistant', label: 'Home Assistant' }],
            }),
          },
          getInstance: { query: async () => null },
          instanceFormSchema: {
            query: async () => ({
              sections: [
                {
                  id: 'conn',
                  title: 'Conn',
                  columns: 1,
                  fields: [
                    {
                      type: 'text',
                      key: 'baseUrl',
                      label: 'HA base URL',
                      placeholder: 'http://homeassistant:8123',
                    },
                  ],
                },
              ],
            }),
          },
          createInstance: {
            mutate: async (input: unknown) => {
              mockAdd(input)
              return { id: 'ha_777' }
            },
          },
          updateInstance: {
            mutate: async (input: unknown) => {
              mockAdd(input)
              return { ok: true }
            },
          },
        },
      },
    }),
  }
})

import { BrokerStep } from '../BrokerStep'

function renderStep(onResolved: (id: string) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <BrokerStep kind="home-assistant" onResolved={onResolved} onBack={() => {}} />
    </QueryClientProvider>,
  )
}

describe('BrokerStep', () => {
  it('lists existing brokers of the required kind and emits the chosen brokerId', () => {
    const onResolved = vi.fn()
    renderStep(onResolved)
    expect(screen.getByText('Home')).toBeTruthy()
    expect(screen.queryByText('Mosquitto')).toBeNull()
    expect(
      (
        screen.getByRole('button', {
          name: /use this broker/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false) // the only broker of the kind is pre-selected

    fireEvent.click(screen.getByText('Home'))
    fireEvent.click(screen.getByRole('button', { name: /use this broker/i }))
    expect(onResolved).toHaveBeenCalledWith('ha_001')
  })

  it('creates a broker in the stacked dialog, comes back with it selected, then resolves it', async () => {
    mockAdd.mockReset()
    const onResolved = vi.fn()
    renderStep(onResolved)

    fireEvent.click(screen.getByRole('button', { name: /create new/i }))
    fireEvent.change(await screen.findByPlaceholderText('http://homeassistant:8123'), {
      target: { value: 'http://ha:8123' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() =>
      expect(screen.queryByPlaceholderText('http://homeassistant:8123')).toBeNull(),
    )
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ addonId: 'provider-homeassistant', name: 'Home Assistant' }),
    )
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ha_777', values: { baseUrl: 'http://ha:8123' } }),
    )
    // Back on the step with the new broker chosen; the operator confirms.
    expect(onResolved).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /use this broker/i }))
    expect(onResolved).toHaveBeenCalledWith('ha_777')
  })
})
