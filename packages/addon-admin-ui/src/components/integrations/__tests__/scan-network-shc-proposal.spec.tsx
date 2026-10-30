// @vitest-environment jsdom
/**
 * A Bosch SHC scan hit is a proposal: the row shows the controller, and Add
 * opens the integration form with the host filled in. It does not adopt a device.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const adopt = vi.hoisted(() => vi.fn(async () => ({ id: 1 })))

const shcCandidate = {
  stableId: 'bosch-shc:shc0123',
  type: 'hub' as const,
  suggestedName: 'Bosch SHC [lab]',
  prefilledConfig: { host: '192.0.2.20', setupIntegration: true },
}

const cameraCandidate = {
  stableId: 'onvif-192-0-2-30',
  type: 'camera' as const,
  suggestedName: 'Lobby',
  prefilledConfig: { host: '192.0.2.30' },
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerAdoptDevice: () => ({ mutateAsync: adopt, isPending: false }),
    useLocalNetworkGetScanSubnets: () => ({ data: { subnets: [] }, refetch: vi.fn() }),
    useLocalNetworkSetScanSubnets: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerListAll: () => ({ data: [], isLoading: false }),
    useDeviceManagerDiscoverAllProviders: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: {
        groups: [
          {
            addonId: 'bosch-shc',
            label: 'Bosch SHC',
            error: null,
            candidates: [shcCandidate],
          },
          {
            addonId: 'provider-onvif',
            label: 'ONVIF',
            error: null,
            candidates: [cameraCandidate],
          },
        ],
      },
    }),
    useDeviceManagerDiscoverProvider: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: undefined,
    }),
    useDeviceManagerProviderDiscoveryParamsSchema: () => ({ data: null, isLoading: false }),
  }
})

import { ScanNetworkModal } from '../ScanNetworkModal'

function renderModal(onSetupIntegration: (seed: unknown) => void): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScanNetworkModal open onClose={vi.fn()} onSetupIntegration={onSetupIntegration} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('Scan network SHC proposal', () => {
  it('shows the controller and opens the add form with the host, without adopting', () => {
    const onSetup = vi.fn()
    render(renderModal(onSetup))

    expect(screen.getByText('Bosch SHC [lab]')).toBeTruthy()
    expect(screen.getByText('192.0.2.20')).toBeTruthy()

    const add = screen.getByTestId('scan-row-bosch-shc:shc0123').querySelector('button')
    expect(add).toBeTruthy()
    if (!add) return
    fireEvent.click(add)

    expect(onSetup).toHaveBeenCalledWith({
      addonId: 'bosch-shc',
      name: 'Bosch SHC [lab]',
      config: { host: '192.0.2.20' },
    })
    expect(adopt).not.toHaveBeenCalled()
  })

  it('still adopts a camera candidate in one click', () => {
    adopt.mockClear()
    render(renderModal(vi.fn()))
    const add = screen.getByTestId('scan-row-onvif-192-0-2-30').querySelector('button')
    expect(add).toBeTruthy()
    if (!add) return
    fireEvent.click(add)
    expect(adopt).toHaveBeenCalledWith({ addonId: 'provider-onvif', candidate: cameraCandidate })
  })
})
