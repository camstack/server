// @vitest-environment jsdom
/**
 * A failed create for one provider must not follow the operator into the next
 * provider they pick: the create banner belongs to that attempt only.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const GATEWAY_ERROR = 'Enter the gateway host or IP address.'

const providers = vi.hoisted(() => {
  const base = {
    description: 'd',
    color: '#000',
    iconUrl: null as string | null,
    instanceMode: 'multiple',
    existingInstances: [] as { id: string }[],
    discoveryMode: 'manual',
    kind: 'device-provider' as const,
    brokerKind: null as string | null,
    canTest: false,
  }
  return {
    list: [
      { ...base, addonId: 'provider-a', name: 'Alpha', mode: 'standalone' as const },
      { ...base, addonId: 'provider-b', name: 'Beta', mode: 'account' as const },
    ],
  }
})

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useIntegrationsGetAvailableTypes: () => ({ data: providers.list, isLoading: false }),
  useAddonsList: () => ({ data: [] }),
  useAddonSettingsGetIntegrationFormSchema: () => ({ data: { sections: [] } }),
  useDeviceManagerAdoptDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeviceManagerDiscoverDevices: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
  useDeviceManagerDiscoveryProviders: () => ({ data: { providers: [] } }),
  useAddonsCustom: () => ({ mutateAsync: vi.fn() }),
  useIntegrationsTestConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useIntegrationsCreate: () => {
    const [error, setError] = useState<Error | null>(null)
    return {
      isPending: false,
      error,
      reset: () => setError(null),
      mutateAsync: async () => {
        const failure = new Error(GATEWAY_ERROR)
        setError(failure)
        throw failure
      },
    }
  },
}))

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { IntegrationWizard } from '../IntegrationWizard'

describe('IntegrationWizard create error', () => {
  it('does not carry a failed create of one provider into the next provider picked', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConfirmDialogProvider>
            <IntegrationWizard open onClose={vi.fn()} />
          </ConfirmDialogProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByTestId('provider-pick-provider-a'))
    await waitFor(() => expect(screen.getByText(GATEWAY_ERROR)).toBeTruthy())

    fireEvent.click(screen.getByTestId('provider-pick-provider-b'))
    await screen.findByLabelText('Integration name')
    expect(screen.queryByText(GATEWAY_ERROR)).toBeNull()
  })
})
