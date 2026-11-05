// @vitest-environment jsdom
/**
 * The ONE Add device modal: the manual tab exists only when the provider
 * declares a creation form, the network list is one row per device whichever
 * source saw it, and a candidate that needs parameters asks for them before it
 * is adopted.
 */
import { DeviceType } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  creationType: 'container' as string | null,
  schema: {
    sections: [
      {
        id: 's',
        fields: [
          { type: 'text', key: 'host', label: 'Host', required: true },
          { type: 'password', key: 'encryptionKey', label: 'API encryption key' },
        ],
      },
    ],
  } as { sections: { id: string; fields: unknown[] }[] },
  scan: [] as unknown[],
  proposals: [] as unknown[],
  adoption: [] as unknown[],
  adopt: vi.fn().mockResolvedValue({}),
}))

const hit = (stableId: string, host: string, extra: Record<string, unknown> = {}) => ({
  stableId,
  type: 'container',
  suggestedName: stableId,
  prefilledConfig: { host },
  ...extra,
})

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerProviderCreationType: () => ({
      data: { deviceType: state.creationType },
      isLoading: false,
      isError: false,
      isSuccess: true,
    }),
    useDeviceManagerGetCreationSchema: () => ({
      data: state.schema,
      isLoading: false,
      isError: false,
      isSuccess: true,
    }),
    useDeviceManagerTestCreationField: () => ({ mutateAsync: vi.fn() }),
    useDeviceManagerCreateDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerAdoptDevice: () => ({ mutateAsync: state.adopt, isPending: false }),
    useDeviceManagerAdoptionStartJob: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerDiscoverProvider: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: { candidates: state.scan },
    }),
    useDeviceManagerProviderDiscoveryParamsSchema: () => ({ data: null, isLoading: false }),
    useDeviceManagerListDiscoveryProposals: () => ({ data: { proposals: state.proposals } }),
    useDeviceManagerAdoptionListCandidates: () => ({
      data: { candidates: state.adoption },
      isError: false,
    }),
    useDeviceManagerListAll: () => ({ data: [], isLoading: false }),
    useLocalNetworkGetScanSubnets: () => ({ data: { subnets: [] }, refetch: vi.fn() }),
    useLocalNetworkSetScanSubnets: () => ({ mutateAsync: vi.fn(), isPending: false }),
    LogStream: () => null,
  }
})

import { AddDeviceModal } from '../AddDeviceModal'

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AddDeviceModal
          addonId="provider-esphome"
          integrationId="int_1"
          kind="device-provider"
          canScan
          onClose={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AddDeviceModal', () => {
  beforeEach(() => {
    state.creationType = DeviceType.Container
    state.schema = {
      sections: [
        {
          id: 's',
          fields: [
            { type: 'text', key: 'host', label: 'Host', required: true },
            { type: 'password', key: 'encryptionKey', label: 'API encryption key' },
          ],
        },
      ],
    }
    state.scan = []
    state.proposals = []
    state.adoption = []
    state.adopt.mockClear()
  })

  it('offers both flows as tabs when the provider declares a creation form', () => {
    renderModal()
    expect(screen.getByRole('tab', { name: 'Found on the network' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Enter parameters' })).toBeTruthy()
  })

  it('hides the manual tab when the provider declares no creation type', () => {
    state.creationType = null
    renderModal()
    expect(screen.queryByRole('tab', { name: 'Enter parameters' })).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByRole('button', { name: /scan now/i })).toBeTruthy()
  })

  it('hides the manual tab when the provider declares a creation type but no field', () => {
    state.schema = { sections: [] }
    renderModal()
    expect(screen.queryByRole('tab', { name: 'Enter parameters' })).toBeNull()
  })

  it('lists a device once when the scan, a proposal and the adoption list all saw it', () => {
    state.scan = [hit('esp-attic', '192.0.2.10')]
    state.proposals = [
      { id: 'p1', addonId: 'provider-esphome', candidate: hit('esp-attic', '192.0.2.10') },
    ]
    state.adoption = [
      {
        childNativeId: 'esp-attic',
        name: 'attic',
        alreadyAdopted: false,
        type: 'container',
        children: [],
      },
    ]
    renderModal()
    expect(screen.getAllByTestId(/^network-row-/)).toHaveLength(1)
  })

  it('ignores a proposal that belongs to another integration', () => {
    state.proposals = [{ id: 'p1', addonId: 'provider-gree', candidate: hit('ac', '192.0.2.20') }]
    renderModal()
    expect(screen.queryAllByTestId(/^network-row-/)).toHaveLength(0)
  })

  it('adds a candidate that needs nothing in one click, for this integration', async () => {
    state.scan = [hit('plain', '192.0.2.11')]
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await waitFor(() => expect(state.adopt).toHaveBeenCalledTimes(1))
    expect(state.adopt.mock.calls[0]?.[0]).toMatchObject({
      addonId: 'provider-esphome',
      integrationId: 'int_1',
    })
  })

  it('asks for the parameters of a candidate that needs them, then adopts with them', async () => {
    state.scan = [hit('enc', '192.0.2.10', { needsParams: ['encryptionKey'] })]
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /enter details/i }))
    expect(state.adopt).not.toHaveBeenCalled()
    expect(screen.getByText('API encryption key')).toBeTruthy()

    const input = document.querySelector<HTMLInputElement>('input[type="password"]')
    expect(input).not.toBeNull()
    fireEvent.change(input as HTMLInputElement, { target: { value: 'SECRET' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => expect(state.adopt).toHaveBeenCalledTimes(1))
    const call = state.adopt.mock.calls[0]?.[0] as {
      candidate: { prefilledConfig: Record<string, unknown> }
    }
    expect(call.candidate.prefilledConfig).toMatchObject({
      host: '192.0.2.10',
      encryptionKey: 'SECRET',
    })
  })
})
