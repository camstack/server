// @vitest-environment jsdom
/**
 * A provider that is a broker AND a device provider (Matter: the fabric and the integrations) has
 * several kinds, so `createInstance` refuses a call that names none ("This provider has several
 * kinds: name one"). The wizard's broker step creates the integration, so it names the kind whose
 * function is the device provider.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ createInstance: [] as unknown[] }))

vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  return {
    ...actual,
    useIntegrationInstancesInstanceFormSchema: () => ({ data: undefined }),
    useDeviceManagerAdoptDevice: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useDeviceManagerDiscoverDevices: () => ({
      mutate: vi.fn(),
      isPending: false,
      data: undefined,
    }),
    useDeviceManagerDiscoveryProviders: () => ({ data: { providers: [] } }),
    useIntegrationsGetAvailableTypes: () => ({ data: [] }),
    useIntegrationInstancesCreateInstance: () => ({
      mutateAsync: async (input: unknown) => {
        calls.createInstance.push(input)
        return { id: 'int_0001' }
      },
      isPending: false,
      error: null,
      reset: vi.fn(),
    }),
    useIntegrationInstancesDescribe: () => ({
      data: {
        kinds: [
          {
            id: 'account',
            label: 'Matter fabric',
            functionCap: 'broker',
            brokerKind: 'matter',
          },
          {
            id: 'integration',
            label: 'Matter',
            functionCap: 'device-provider',
          },
        ],
      },
    }),
  }
})

vi.mock('../ProviderPicker', () => ({
  ProviderPicker: (props: { onSelect: (...args: unknown[]) => void }) => (
    <button
      type="button"
      onClick={() =>
        props.onSelect(
          'matter-broker',
          'multiple',
          'manual',
          'Matter',
          'device-provider',
          'matter',
          'broker',
          false,
        )
      }
    >
      pick-matter
    </button>
  ),
}))
vi.mock('../BrokerStep', () => ({
  BrokerStep: (props: { onResolved: (id: string) => void }) => (
    <button type="button" onClick={() => props.onResolved('broker_1')}>
      use-broker
    </button>
  ),
}))

import { ConfirmDialogProvider } from '@dominevo/ui-library'
import { fireEvent } from '@testing-library/react'
import { IntegrationWizard } from '../IntegrationWizard'

describe('IntegrationWizard broker step', () => {
  beforeEach(() => {
    calls.createInstance.length = 0
  })

  it('names the integration kind when the provider also owns the broker kind', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConfirmDialogProvider>
            <IntegrationWizard open onClose={vi.fn()} />
          </ConfirmDialogProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByText('pick-matter'))
    fireEvent.click(await screen.findByText('use-broker'))
    await waitFor(() => expect(calls.createInstance.length).toBe(1))
    expect(calls.createInstance[0]).toMatchObject({
      addonId: 'matter-broker',
      kind: 'integration',
      values: { brokerId: 'broker_1' },
    })
  })
})
