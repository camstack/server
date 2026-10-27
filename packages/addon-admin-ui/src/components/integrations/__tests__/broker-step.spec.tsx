/**
 * BrokerStep — the integration wizard's broker gate. It is a `BrokerPicker`
 * plus a confirm button: pick a broker of the required kind, or "Create new…"
 * (the shared dialog, stacked over the wizard) and come back with it selected.
 * Either way the step resolves to one `brokerId`. The create / sign-in
 * behaviour itself is pinned in `brokers/__tests__/broker-editor-flow.spec.tsx`.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    useBrokerAdd: (opts?: { onSuccess?: (created: { id: string }) => void }) => ({
      mutate: (input: unknown) => {
        mockAdd(input)
        opts?.onSuccess?.({ id: 'ha_777' })
      },
      isPending: false,
      isError: false,
    }),
    useBrokerGetSettingsSchema: () => ({
      data: {
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
      },
      isLoading: false,
      isError: false,
    }),
    useBrokerTestSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    ).toBe(true)

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
    fireEvent.change(screen.getByPlaceholderText('My Home Assistant'), {
      target: { value: 'My HA' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create broker/i }))

    expect(mockAdd).toHaveBeenCalledWith({
      kind: 'home-assistant',
      name: 'My HA',
      settings: { baseUrl: 'http://ha:8123' },
      addonId: 'provider-homeassistant',
    })
    // Back on the step with the new broker chosen; the operator confirms.
    expect(onResolved).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /use this broker/i }))
    expect(onResolved).toHaveBeenCalledWith('ha_777')
  })
})
