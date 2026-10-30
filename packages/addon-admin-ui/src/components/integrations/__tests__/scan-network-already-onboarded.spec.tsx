// @vitest-environment jsdom
/**
 * A candidate the provider already matched to a stored device (`alreadyOnboarded`)
 * is shown as "Already added" even when its stableId differs from the stored one
 * (scan key `host-<ip>` vs stored `mac-<mac>`), a gateway child included.
 */
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const found = vi.hoisted(() => ({
  groups: [
    {
      addonId: 'reolink',
      label: 'Reolink',
      error: null,
      candidates: [
        {
          stableId: 'host-192.0.2.60',
          type: 'hub',
          suggestedName: 'Home Hub',
          prefilledConfig: { host: '192.0.2.60' },
          alreadyOnboarded: true,
          onboardedDeviceId: 7,
          onboardedName: 'Hub in the hall',
        },
        {
          stableId: 'host-192.0.2.61',
          type: 'camera',
          suggestedName: 'Garden',
          prefilledConfig: {},
          parentStableId: 'host-192.0.2.60',
          alreadyOnboarded: true,
        },
        {
          stableId: 'host-192.0.2.62',
          type: 'camera',
          suggestedName: 'New one',
          prefilledConfig: { host: '192.0.2.62' },
        },
      ],
    },
  ],
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerAdoptDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    useLocalNetworkGetScanSubnets: () => ({ data: { subnets: [] }, refetch: vi.fn() }),
    useLocalNetworkSetScanSubnets: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

import { ScanNetworkModal } from '../ScanNetworkModal'

describe('Scan network modal — already onboarded candidates', () => {
  it('shows a provider-matched candidate and its child as already added, without an Add button', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ScanNetworkModal open onClose={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const hub = screen.getByTestId('scan-row-host-192.0.2.60')
    expect(within(hub).getByText('Already added')).toBeTruthy()
    expect(within(hub).queryByRole('button')).toBeNull()
    expect(within(hub).getByText('Hub in the hall')).toBeTruthy()
    const child = screen.getByTestId('scan-row-host-192.0.2.61')
    expect(within(child).getByText('Already added')).toBeTruthy()
    expect(within(child).queryByRole('button')).toBeNull()
    const fresh = screen.getByTestId('scan-row-host-192.0.2.62')
    expect(within(fresh).queryByText('Already added')).toBeNull()
    expect(within(fresh).getByRole('button', { name: /add/i })).toBeTruthy()
  })
})
