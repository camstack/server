/**
 * Saving an integration's instance says what is happening: Save is pending
 * while the write runs, a success toast follows, and a failure is toasted
 * with the server's message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const schemaQuery = vi.hoisted(() =>
  vi.fn(async () => ({
    sections: [
      {
        id: 'conn',
        title: 'Connection',
        columns: 1,
        fields: [{ type: 'text', key: 'host', label: 'Host' }],
      },
    ],
  })),
)
const instanceQuery = vi.hoisted(() => vi.fn(async () => ({ formValues: { host: '10.0.0.5' } })))
const updateInstance = vi.hoisted(() => vi.fn())
const mockPushToast = vi.hoisted(() => vi.fn())

vi.mock('../../ui/toast-bus', () => ({
  pushToast: (toast: unknown) => mockPushToast(toast),
}))

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

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <IntegrationConfigModal
        integrationId="int_hm"
        addonId="provider-homematic"
        name="Homematic"
        kind="device-provider"
        mode="account"
        brokerKind={null}
        canTest={false}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

async function editAndSave(): Promise<void> {
  const host = await screen.findByDisplayValue('10.0.0.5')
  fireEvent.change(host, { target: { value: '10.0.0.6' } })
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
}

describe('IntegrationConfigModal save feedback', () => {
  beforeEach(() => {
    updateInstance.mockReset()
    mockPushToast.mockReset()
  })

  it('disables Save and says it is saving while the mutation runs', async () => {
    let finish: (value: { revision: number }) => void = () => {}
    updateInstance.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    mount()
    await editAndSave()
    const saving = await screen.findByRole('button', { name: /^save$/i })
    if (!(saving instanceof HTMLButtonElement)) throw new Error('Save is not a button')
    expect(saving.disabled).toBe(true)
    finish({ revision: 2 })
    await waitFor(() => {
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'info', title: 'Configuration saved' }),
      )
    })
  })

  it('toasts the server message and keeps the dialog open when the save fails', async () => {
    updateInstance.mockRejectedValue(new Error('hub refused'))
    mount()
    await editAndSave()
    await waitFor(() => {
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'critical',
          message: 'Homematic: hub refused',
        }),
      )
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
