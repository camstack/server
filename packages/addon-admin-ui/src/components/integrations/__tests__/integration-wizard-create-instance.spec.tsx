// @vitest-environment jsdom
/**
 * The new-integration wizard creates through `integration-instances.createInstance` (D1013 rule 1,
 * #440 H3): the hub mints the id, gates the create on the connection test and writes the registry
 * row and the record together. The wizard no longer calls the legacy `integrations.create`, and the
 * discovery candidate it was seeded from travels as `originStableId`.
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
      title: 'Controller',
      columns: 1,
      fields: [
        { type: 'text', key: 'host', label: 'Host', placeholder: '192.0.2.20' },
        { type: 'password', key: 'systemPassword', label: 'System password' },
      ],
    },
  ],
}

const calls = vi.hoisted(() => ({
  createInstance: [] as unknown[],
  legacyCreate: [] as unknown[],
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useIntegrationInstancesInstanceFormSchema: () => ({ data: schema }),
    useDeviceManagerAdoptDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerDiscoverDevices: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
    useIntegrationsCreate: () => ({
      mutateAsync: async (input: unknown) => {
        calls.legacyCreate.push(input)
        return { id: 'legacy' }
      },
      isPending: false,
      error: null,
    }),
    useIntegrationInstancesCreateInstance: () => ({
      mutateAsync: async (input: unknown) => {
        calls.createInstance.push(input)
        return { id: 'int_0042' }
      },
      isPending: false,
      error: null,
    }),
    useDeviceManagerDiscoveryProviders: () => ({ data: { providers: [] } }),
    useIntegrationsGetAvailableTypes: () => ({
      data: [{ addonId: 'bosch-shc', canTest: false, discoveryMode: 'manual', mode: 'account' }],
    }),
    useAddonsCustom: () => ({ mutateAsync: vi.fn(async () => ({ ok: true })) }),
    useIntegrationInstancesDescribe: () => ({
      data: {
        kinds: [{ id: 'default', label: 'Default', functionCap: 'device-provider', canTest: true }],
      },
    }),
    useIntegrationInstancesTestInstance: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

// After a create the wizard resets to its picker, which reads installed addons over tRPC.
vi.mock('../ProviderPicker', () => ({ ProviderPicker: () => null }))

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
              originStableId: 'shc-aa:bb',
            }}
          />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('IntegrationWizard create', () => {
  beforeEach(() => {
    calls.createInstance.length = 0
    calls.legacyCreate.length = 0
  })

  it('creates through createInstance with the kind, the values and the candidate', async () => {
    render(renderWizard())
    fireEvent.click(screen.getByRole('button', { name: /forward|next/i }))
    await waitFor(() => expect(calls.createInstance.length).toBe(1))
    expect(calls.legacyCreate).toEqual([])
    expect(calls.createInstance[0]).toEqual({
      addonId: 'bosch-shc',
      name: 'Bosch SHC [lab]',
      kind: 'default',
      values: { host: '192.0.2.20' },
      originStableId: 'shc-aa:bb',
    })
  })
})
