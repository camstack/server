/**
 * An integration's configuration is its instance record. The dialog loads
 * `instanceFormSchema(id)` and saves through `updateInstance`.
 */
import type { ReactElement } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const schemaQuery = vi.hoisted(() => vi.fn())
const instanceQuery = vi.hoisted(() => vi.fn())
const updateInstance = vi.hoisted(() => vi.fn(async () => ({ revision: 2 })))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          instanceFormSchema: { query: schemaQuery },
          getInstance: { query: instanceQuery },
          updateInstance: { mutate: updateInstance },
        },
      },
    }),
  }
})

import { IntegrationConfigModal } from '../IntegrationConfigModal'

function renderWithClient(ui: ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function mount(): void {
  renderWithClient(
    <IntegrationConfigModal
      integrationId="int_wyze"
      addonId="provider-wyze"
      name="Wyze casa"
      kind="device-adoption"
      mode="account"
      brokerKind={null}
      canTest={false}
      onClose={() => {}}
    />,
  )
}

describe('IntegrationConfigModal', () => {
  it('asks the instance for its form and shows that the record has none', async () => {
    schemaQuery.mockResolvedValue(null)
    instanceQuery.mockResolvedValue(null)
    mount()
    expect(await screen.findByText(/no configuration form/i)).toBeTruthy()
    expect(schemaQuery).toHaveBeenCalledWith({ addonId: 'provider-wyze', id: 'int_wyze' })
    expect(screen.queryByRole('button', { name: /use this broker/i })).toBeNull()
  })

  it('renders the instance fields and saves only the changed values', async () => {
    schemaQuery.mockResolvedValue({
      sections: [
        {
          id: 'conn',
          title: 'Connection',
          columns: 1,
          fields: [{ type: 'text', key: 'host', label: 'Host' }],
        },
      ],
    })
    instanceQuery.mockResolvedValue({ formValues: { host: '10.0.0.8' } })
    mount()
    const host = await screen.findByDisplayValue('10.0.0.8')
    fireEvent.change(host, { target: { value: '10.0.0.9' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => {
      expect(updateInstance).toHaveBeenCalledWith({
        addonId: 'provider-wyze',
        id: 'int_wyze',
        values: { host: '10.0.0.9' },
      })
    })
  })
})
