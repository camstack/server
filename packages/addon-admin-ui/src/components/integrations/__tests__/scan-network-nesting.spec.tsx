// @vitest-environment jsdom
/**
 * The scan modal nests a gateway's children under it, lets several boards be
 * ticked and added at once, and edits the saved extra subnets.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const adopt = vi.hoisted(() => vi.fn(async () => ({ id: 1 })))
const setSubnets = vi.hoisted(() => vi.fn(async () => ({ subnets: [] })))

const found = vi.hoisted(() => ({
  groups: [
    {
      addonId: 'hue',
      label: 'Hue',
      error: null,
      candidates: [
        {
          stableId: 'hue:bridge',
          type: 'hub',
          suggestedName: 'Bridge',
          prefilledConfig: { host: '192.0.2.40' },
          selectable: false,
        },
        {
          stableId: 'hue:lamp-1',
          type: 'light',
          suggestedName: 'Lamp one',
          prefilledConfig: {},
          parentStableId: 'hue:bridge',
        },
        {
          stableId: 'hue:lamp-2',
          type: 'light',
          suggestedName: 'Lamp two',
          prefilledConfig: {},
          parentStableId: 'hue:bridge',
        },
        {
          stableId: 'hue:lost',
          type: 'light',
          suggestedName: 'Lamp orphan',
          prefilledConfig: {},
          parentStableId: 'hue:gone',
        },
      ],
    },
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
        {
          stableId: 'esp:b',
          type: 'sensor',
          suggestedName: 'Board B',
          prefilledConfig: { host: '198.51.100.8' },
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
    useLocalNetworkGetScanSubnets: () => ({
      data: { subnets: ['203.0.113.0/24'] },
      refetch: vi.fn(),
    }),
    useLocalNetworkSetScanSubnets: () => ({ mutateAsync: setSubnets, isPending: false }),
  }
})

import { ScanNetworkModal } from '../ScanNetworkModal'

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ScanNetworkModal open onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Scan network modal — nesting and bulk add', () => {
  it('nests the children under their gateway and keeps an orphan at the top level', () => {
    renderModal()
    const bridge = screen.getByTestId('scan-row-hue:bridge')
    const children = within(bridge.parentElement as HTMLElement).getByTestId('scan-children')
    expect(within(children).getByText('Lamp one')).toBeTruthy()
    expect(within(children).getByText('Lamp two')).toBeTruthy()
    const orphan = screen.getByTestId('scan-row-hue:lost')
    expect(children.contains(orphan)).toBe(false)
    expect(orphan.closest('[data-testid="scan-children"]')).toBeNull()
  })

  it('offers no checkbox on a gateway that is not selectable', () => {
    renderModal()
    expect(within(screen.getByTestId('scan-row-hue:bridge')).queryByRole('checkbox')).toBeNull()
  })

  it('adds several ticked boards with one click', async () => {
    adopt.mockClear()
    renderModal()
    fireEvent.click(screen.getByLabelText('Select Board A'))
    fireEvent.click(screen.getByLabelText('Select Board B'))
    fireEvent.click(screen.getByTestId('scan-add-selected'))
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(2))
    const adopted = adopt.mock.calls.map(
      (c) => (c as unknown as [{ candidate: { stableId: string } }])[0].candidate.stableId,
    )
    expect(adopted.sort()).toEqual(['esp:a', 'esp:b'])
  })
})

describe('Scan network modal — extra subnets', () => {
  it('shows the saved subnets and saves an added one', async () => {
    setSubnets.mockClear()
    renderModal()
    expect(screen.getByTestId('scan-subnet-203.0.113.0/24')).toBeTruthy()
    fireEvent.change(screen.getByTestId('scan-subnet-input'), {
      target: { value: '192.0.2.0/24' },
    })
    fireEvent.click(screen.getByTestId('scan-subnet-add'))
    await waitFor(() =>
      expect(setSubnets).toHaveBeenCalledWith({ subnets: ['203.0.113.0/24', '192.0.2.0/24'] }),
    )
  })

  it('refuses a malformed CIDR without calling the server', () => {
    setSubnets.mockClear()
    renderModal()
    fireEvent.change(screen.getByTestId('scan-subnet-input'), { target: { value: 'nonsense' } })
    fireEvent.click(screen.getByTestId('scan-subnet-add'))
    expect(setSubnets).not.toHaveBeenCalled()
    expect(screen.getByText('Enter a network like 192.0.2.0/24.')).toBeTruthy()
  })
})
