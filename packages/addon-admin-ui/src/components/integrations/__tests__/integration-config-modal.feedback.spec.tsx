/**
 * Saving an integration's configuration must say what is happening: the Save
 * button is pending while the mutation runs, a success toast follows, and a
 * failure is toasted with the server's message (and the dialog stays open).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

interface SetSettingsOptions {
  readonly onSuccess?: () => void
  readonly onError?: (err: Error) => void
}

const mutationState = { isPending: false, isError: false }
const mockMutate = vi.fn()
const mockPushToast = vi.fn()

vi.mock('../../ui/toast-bus', () => ({
  pushToast: (toast: unknown) => mockPushToast(toast),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useIntegrationsGetSettings: () => ({ data: { host: '10.0.0.5' }, isLoading: false }),
    useIntegrationsSetSettings: () => ({
      mutate: mockMutate,
      isPending: mutationState.isPending,
      isError: mutationState.isError,
    }),
    useAddonSettingsGetIntegrationFormSchema: () => ({
      data: {
        sections: [
          {
            id: 'conn',
            title: 'Connection',
            columns: 1,
            fields: [{ type: 'text', key: 'host', label: 'Host', required: true }],
          },
        ],
      },
      isLoading: false,
    }),
    useIntegrationsTestConnection: () => ({ mutate: vi.fn(), isPending: false }),
    useAddonsCustom: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

import { IntegrationConfigModal } from '../IntegrationConfigModal'

const noopTrpc = {
  addonSettings: {
    getGlobalSettings: { query: vi.fn(async () => null) },
    updateGlobalSettings: { mutate: vi.fn(async () => undefined) },
  },
}

function mount(onClose: () => void = () => {}): void {
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
        trpc={noopTrpc}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
}

describe('IntegrationConfigModal save feedback', () => {
  beforeEach(() => {
    mutationState.isPending = false
    mutationState.isError = false
    mockMutate.mockReset()
    mockPushToast.mockReset()
  })

  it('disables Save and says it is saving while the mutation runs', () => {
    mutationState.isPending = true
    mount()
    const button = screen.getByRole('button', { name: /saving/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('toasts success and closes when the save lands', () => {
    const onClose = vi.fn()
    mockMutate.mockImplementation((_input: unknown, options: SetSettingsOptions) =>
      options.onSuccess?.(),
    )
    mount(onClose)
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'info', message: 'Homematic' }),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('toasts the error message and stays open when the save fails', () => {
    const onClose = vi.fn()
    mockMutate.mockImplementation((_input: unknown, options: SetSettingsOptions) =>
      options.onError?.(new Error('CCU refused the credentials')),
    )
    mount(onClose)
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'critical',
        message: expect.stringContaining('CCU refused the credentials'),
      }),
    )
    expect(onClose).not.toHaveBeenCalled()
  })
})
