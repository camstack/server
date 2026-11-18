// @vitest-environment jsdom
/**
 * The background proposals live in the generic adopt-mode scan modal only, and
 * an adoption through the scan list tells the page to re-read them.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const adopt = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ id: 1 })))

const found = vi.hoisted(() => ({
  groups: [
    {
      addonId: 'esphome',
      label: 'ESPHome',
      error: null,
      candidates: [
        {
          stableId: 'esp:a',
          type: 'sensor',
          suggestedName: 'Board A',
          prefilledConfig: { host: '198.51.100.7' },
        },
      ],
    },
  ],
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerAdoptDevice: () => ({ mutateAsync: adopt, isPending: false }),
    useDeviceManagerListAll: () => ({ data: [], isLoading: false }),
    useDeviceManagerDiscoverAllProviders: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: found,
    }),
    useDeviceManagerDiscoverProvider: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: undefined,
    }),
    useDeviceManagerProviderDiscoveryParamsSchema: () => ({ data: null, isLoading: false }),
    useDeviceManagerListDiscoveryProposals: () => ({
      data: {
        proposals: [
          {
            id: 'provider-gree::gree-1',
            addonId: 'provider-gree',
            candidate: {
              stableId: 'gree-1',
              suggestedName: 'Bedroom AC',
              type: 'climate',
              prefilledConfig: {},
            },
          },
        ],
      },
      refetch: vi.fn(),
    }),
    useDeviceManagerDismissDiscoveryProposal: () => ({ mutateAsync: vi.fn() }),
    useLocalNetworkGetScanSubnets: () => ({ data: { subnets: [] }, refetch: vi.fn() }),
    useLocalNetworkSetScanSubnets: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

import { ScanNetworkModal } from '../ScanNetworkModal'

type ModalProps = Partial<Parameters<typeof ScanNetworkModal>[0]>

function renderModal(props: ModalProps = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScanNetworkModal open onClose={vi.fn()} onSetupIntegration={vi.fn()} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Scan network modal — background proposals', () => {
  it('shows the section in the generic adopt mode', () => {
    renderModal()
    expect(screen.getByTestId('discovery-proposals')).toBeTruthy()
    expect(screen.getByText('Bedroom AC')).toBeTruthy()
  })

  it('hides it in the scoped mode and in the fill mode', () => {
    const { unmount } = renderModal({ scope: { addonId: 'esphome', label: 'ESPHome' } })
    expect(screen.queryByTestId('discovery-proposals')).toBeNull()
    unmount()
    renderModal({ pickMode: 'fill' })
    expect(screen.queryByTestId('discovery-proposals')).toBeNull()
  })

  it('reports an adoption from the scan list so the proposals are re-read', async () => {
    adopt.mockClear()
    const onAdopted = vi.fn()
    renderModal({ onAdopted })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(onAdopted).toHaveBeenCalledTimes(1))
    expect(adopt).toHaveBeenCalledTimes(1)
  })

  it('does not report a failed adoption', async () => {
    adopt.mockClear()
    adopt.mockRejectedValueOnce(new Error('nope'))
    const onAdopted = vi.fn()
    renderModal({ onAdopted })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1))
    expect(onAdopted).not.toHaveBeenCalled()
  })
})
