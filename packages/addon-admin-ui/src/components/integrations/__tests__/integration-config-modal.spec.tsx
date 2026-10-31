/**
 * IntegrationConfigModal — Edit configuration. Branched on wizard `mode`,
 * not on cap `kind`:
 *   - broker     → re-link BrokerStep (HA)
 *   - account    → the SAME credential form the create wizard used
 *   - standalone → addon global settings
 *
 * Partial-mock of `@camstack/ui-library`: stub the integration + broker hooks
 * so the real BrokerStep / FormBuilder keep their implementations.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'

const mockSetSettings = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useIntegrationsGetSettings: () => ({
      data: {
        brokerId: 'ha_001',
        email: 'a@b.com',
        password: 'secret',
        apiKey: 'k',
        apiId: 'kid',
      },
      isLoading: false,
    }),
    useIntegrationsSetSettings: () => ({
      mutate: mockSetSettings,
      isPending: false,
      isError: false,
    }),
    useAddonSettingsGetIntegrationFormSchema: () => ({
      data: {
        sections: [
          {
            id: 'credentials',
            title: 'Wyze account',
            columns: 2,
            fields: [
              { type: 'text', key: 'email', label: 'Email', required: true },
              { type: 'password', key: 'password', label: 'Password', required: true },
              { type: 'password', key: 'apiKey', label: 'API Key', required: true },
              { type: 'text', key: 'apiId', label: 'Key ID', required: true },
            ],
          },
        ],
      },
      isLoading: false,
    }),
    useIntegrationsTestConnection: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useBrokerList: () => ({
      data: [
        {
          id: 'ha_001',
          addonId: 'provider-homeassistant',
          name: 'Casa',
          kind: 'home-assistant',
          status: 'connected',
          info: {},
          lastCheckedAt: null,
          error: null,
        },
        {
          id: 'mqtt_001',
          addonId: 'mqtt-broker',
          name: 'Mosquitto',
          kind: 'mqtt',
          status: 'connected',
          info: {},
          lastCheckedAt: null,
          error: null,
        },
      ],
      isLoading: false,
    }),
    useBrokerListProviders: () => ({
      data: [
        {
          addonId: 'provider-homeassistant',
          kinds: [{ kind: 'home-assistant', label: 'Home Assistant' }],
        },
      ],
    }),
    useBrokerGetSettingsSchema: () => ({
      data: {
        sections: [
          {
            id: 'conn',
            title: 'Conn',
            columns: 1,
            fields: [{ type: 'text', key: 'baseUrl', label: 'HA base URL' }],
          },
        ],
      },
      isLoading: false,
    }),
    useBrokerAdd: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      reset: vi.fn(),
    }),
    useBrokerTestSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useAddonsCustom: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
  }
})

import { IntegrationConfigModal } from '../IntegrationConfigModal'

const noopTrpc = {
  addonSettings: {
    getGlobalSettings: { query: vi.fn(async () => null) },
    updateGlobalSettings: { mutate: vi.fn(async () => undefined) },
  },
}

function renderWithClient(ui: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('IntegrationConfigModal', () => {
  it('broker mode: re-links the broker via setSettings with the chosen brokerId', () => {
    mockSetSettings.mockReset()
    renderWithClient(
      <IntegrationConfigModal
        integrationId="int_ha"
        addonId="provider-homeassistant"
        name="Casa"
        kind="device-adoption"
        mode="broker"
        brokerKind="home-assistant"
        trpc={noopTrpc}
        onClose={() => {}}
      />,
    )

    // The existing-broker list shows only HA-kind brokers; pick + confirm.
    expect(screen.getByText('Casa')).toBeTruthy()
    fireEvent.click(screen.getByText('Casa'))
    fireEvent.click(screen.getByRole('button', { name: /use this broker/i }))

    expect(mockSetSettings).toHaveBeenCalledWith(
      { id: 'int_ha', settings: { brokerId: 'ha_001' } },
      expect.anything(),
    )
  })

  it('broker mode with no brokerKind shows a clear error instead of the broker step', () => {
    renderWithClient(
      <IntegrationConfigModal
        integrationId="int_ha"
        addonId="provider-homeassistant"
        name="Casa"
        kind="device-adoption"
        mode="broker"
        brokerKind={null}
        trpc={noopTrpc}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/no brokerKind/i)).toBeTruthy()
  })

  it('account mode (Wyze) shows the wizard credential fields, not the missing-brokerKind error', () => {
    renderWithClient(
      <IntegrationConfigModal
        integrationId="int_wyze"
        addonId="provider-wyze"
        name="Wyze casa"
        kind="device-adoption"
        mode="account"
        brokerKind={null}
        canTest={false}
        trpc={noopTrpc}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText(/no brokerKind/i)).toBeNull()
    expect(screen.getByText('Email')).toBeTruthy()
    expect(screen.getByDisplayValue('a@b.com')).toBeTruthy()
    expect(screen.queryByText(/integrationName/i)).toBeNull()
  })

  it('account mode Save writes integration.settings, not addon global settings', () => {
    mockSetSettings.mockReset()
    renderWithClient(
      <IntegrationConfigModal
        integrationId="int_wyze"
        addonId="provider-wyze"
        name="Wyze casa"
        kind="device-adoption"
        mode="account"
        brokerKind={null}
        canTest={false}
        trpc={noopTrpc}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(mockSetSettings).toHaveBeenCalledWith(
      {
        id: 'int_wyze',
        settings: {
          email: 'a@b.com',
          password: 'secret',
          apiKey: 'k',
          apiId: 'kid',
        },
        // The keys the schema declares secret by type travel with the save, so
        // the hub keeps their values in the keychain (D787).
        secretKeys: ['password', 'apiKey'],
      },
      expect.anything(),
    )
  })
})
