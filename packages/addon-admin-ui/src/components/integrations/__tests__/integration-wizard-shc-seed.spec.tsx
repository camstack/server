// @vitest-environment jsdom
/**
 * A scan proposal opens the add form with the host already filled and the
 * SHC pairing step (button press on the controller) still on the form.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigUISchema } from '../../../types/config-ui'

const schema: ConfigUISchema = {
  sections: [
    {
      id: 'connection',
      title: 'Smart Home Controller',
      columns: 1,
      fields: [
        {
          type: 'text',
          key: 'host',
          label: 'Host',
          placeholder: '192.0.2.20',
        },
        {
          type: 'info',
          key: 'hint',
          label: 'Pair with the controller',
          content: 'Press the button on the controller until the LED blinks.',
        },
        {
          type: 'password',
          key: 'systemPassword',
          label: 'System password',
        },
        {
          type: 'addon-action-button',
          addonId: 'bosch-shc',
          key: 'register',
          label: 'Client registration',
          buttonLabel: 'Register on controller',
          action: 'registerClient',
        },
      ],
    },
  ],
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useAddonSettingsGetGlobalSettings: () => ({ data: schema }),
    useDeviceManagerAdoptDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerDiscoverDevices: () => ({
      mutate: vi.fn(),
      isPending: false,
      data: undefined,
    }),
    useIntegrationsCreate: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
    useDeviceManagerDiscoveryProviders: () => ({ data: { providers: [] } }),
    useIntegrationsGetAvailableTypes: () => ({
      data: [
        {
          addonId: 'bosch-shc',
          canTest: false,
          discoveryMode: 'manual',
        },
      ],
    }),
    useAddonsCustom: () => ({ mutateAsync: vi.fn(async () => ({ ok: true })) }),
    useIntegrationsTestConnection: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { IntegrationWizard } from '../IntegrationWizard'

function renderWizard(): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConfirmDialogProvider>
          <IntegrationWizard
            open
            onClose={vi.fn()}
            seed={{
              addonId: 'bosch-shc',
              name: 'Bosch SHC [lab]',
              config: { host: '192.0.2.20' },
            }}
          />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('IntegrationWizard SHC seed', () => {
  it('prefills the host and keeps the pairing step', () => {
    render(renderWizard())
    const host = screen.getByPlaceholderText('192.0.2.20')
    expect(host).toBeTruthy()
    if (!(host instanceof HTMLInputElement)) return
    expect(host.value).toBe('192.0.2.20')
    expect(screen.getByDisplayValue('Bosch SHC [lab]')).toBeTruthy()
    expect(screen.getByText(/Press the button on the controller/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Register on controller' })).toBeTruthy()
  })
})
