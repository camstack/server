/**
 * The Config modal shows the STORED value of a select, never the schema default or a
 * country-derived one (`amazon.it` stored, `amazon.com` default).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          instanceFormSchema: {
            query: async () => ({
              sections: [
                {
                  id: 'a',
                  title: 'Account',
                  columns: 1,
                  fields: [
                    {
                      type: 'select',
                      key: 'amazonDomain',
                      label: 'Amazon domain (region)',
                      options: ['amazon.com', 'amazon.it'].map((value) => ({
                        value,
                        label: value,
                      })),
                      default: 'amazon.com',
                      defaultByCountry: { IT: 'amazon.it' },
                    },
                  ],
                },
              ],
            }),
          },
          getInstance: { query: async () => ({ formValues: { amazonDomain: 'amazon.it' } }) },
          updateInstance: { mutate: async () => ({}) },
        },
      },
    }),
  }
})

import { IntegrationConfigModal } from '../IntegrationConfigModal'

describe('IntegrationConfigModal select', () => {
  it('shows the stored option, not the schema default', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <IntegrationConfigModal
          integrationId="alexa_002"
          addonId="import-alexa"
          name="Alexa"
          kind="device-adoption"
          mode="account"
          brokerKind={null}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )
    const select = await screen.findByRole('combobox')
    expect(select).toHaveProperty('value', 'amazon.it')
  })
})
