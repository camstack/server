// @vitest-environment jsdom
/**
 * A new integration is prefilled "<Provider> - Home" (editable). The picker
 * still shows the catalog title; the create call carries the prefill.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUISchema } from '../../../types/config-ui'

const schema: ConfigUISchema = {
  sections: [
    {
      id: 'connection',
      title: 'Account',
      columns: 1,
      fields: [{ type: 'text', key: 'host', label: 'Host' }],
    },
  ],
}

const calls = vi.hoisted(() => ({
  createInstance: [] as unknown[],
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useIntegrationInstancesInstanceFormSchema: () => ({ data: schema }),
    useDeviceManagerAdoptDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerDiscoverDevices: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
    useIntegrationsCreate: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
    useIntegrationInstancesCreateInstance: () => ({
      mutateAsync: async (input: unknown) => {
        calls.createInstance.push(input)
        return { id: 'int_0007' }
      },
      isPending: false,
      error: null,
      reset: vi.fn(),
    }),
    useDeviceManagerDiscoveryProviders: () => ({ data: { providers: [] } }),
    useIntegrationsGetAvailableTypes: () => ({
      data: [
        {
          addonId: 'bosch-shc',
          name: 'Bosch Smart Home',
          providerLabel: 'Bosch SHC',
          canTest: false,
          discoveryMode: 'manual',
          mode: 'account' as const,
          brokerKind: null,
        },
      ],
    }),
    useAddonsCustom: () => ({ mutateAsync: vi.fn(async () => ({ ok: true })) }),
    useIntegrationInstancesDescribe: () => ({ data: { kinds: [] } }),
    useIntegrationInstancesTestInstance: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

vi.mock('../ProviderPicker', () => ({
  ProviderPicker: (props: {
    onSelect: (
      addonId: string,
      instanceMode: string,
      discoveryMode: string,
      displayName: string,
      kind: 'device-adoption' | 'device-provider',
      brokerKind: string | null,
      mode: 'standalone' | 'account' | 'broker',
      canTest: boolean,
    ) => void
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          props.onSelect(
            'provider-reolink',
            'multiple',
            'manual',
            'Reolink',
            'device-provider',
            null,
            'standalone',
            false,
          )
        }
      >
        pick reolink
      </button>
      <button
        type="button"
        onClick={() =>
          props.onSelect(
            'bosch-shc',
            'multiple',
            'manual',
            'Bosch SHC',
            'device-adoption',
            null,
            'account',
            false,
          )
        }
      >
        pick shc
      </button>
    </div>
  ),
}))

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { IntegrationWizard } from '../IntegrationWizard'

function renderWizard(seed?: {
  readonly addonId: string
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
}): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConfirmDialogProvider>
          <IntegrationWizard open onClose={vi.fn()} {...(seed !== undefined ? { seed } : {})} />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('IntegrationWizard name prefill', () => {
  beforeEach(() => {
    calls.createInstance.length = 0
  })

  it('creates a standalone integration as "<Provider> - Home"', async () => {
    render(renderWizard())
    fireEvent.click(screen.getByRole('button', { name: 'pick reolink' }))
    await waitFor(() => expect(calls.createInstance.length).toBe(1))
    expect(calls.createInstance[0]).toMatchObject({
      addonId: 'provider-reolink',
      name: 'Reolink - Home',
    })
  })

  it('prefills a manual account with the product label, not a blank name', () => {
    render(renderWizard())
    fireEvent.click(screen.getByRole('button', { name: 'pick shc' }))
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('Bosch SHC - Home')
  })

  it('replaces a discovery id with "<Provider> - Home"', () => {
    render(
      renderWizard({
        addonId: 'bosch-shc',
        name: 'Bosch SHC [lab]',
        config: { host: '192.0.2.20' },
      }),
    )
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('Bosch SHC - Home')
  })
})
