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
  /** Integrations the provider answers "no manual creation" for. */
  hubIntegrations: [] as string[],
  schema: {
    sections: [
      {
        id: 's',
        fields: [
          { type: 'text', key: 'host', label: 'Host', required: true },
          {
            type: 'password',
            key: 'encryptionKey',
            label: 'API encryption key',
          },
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
    useDeviceManagerProviderCreationType: (input: { integrationId?: string }) => ({
      data: {
        deviceType:
          input.integrationId !== undefined && state.hubIntegrations.includes(input.integrationId)
            ? null
            : state.creationType,
      },
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
    useDeviceManagerCreateDevice: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useDeviceManagerAdoptDevice: () => ({
      mutateAsync: state.adopt,
      isPending: false,
    }),
    useDeviceManagerAdoptionStartJob: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useDeviceManagerDiscoverProvider: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: { candidates: state.scan },
    }),
    useDeviceManagerProviderDiscoveryParamsSchema: () => ({
      data: null,
      isLoading: false,
    }),
    useDeviceManagerListDiscoveryProposals: () => ({
      data: { proposals: state.proposals },
    }),
    useDeviceManagerAdoptionListCandidates: () => ({
      data: { candidates: state.adoption },
      isError: false,
    }),
    useDeviceManagerAdoptionListCandidateFilters: () => ({ data: { filters: [] }, isError: false }),
    useIntegrationsGetAvailableTypes: () => ({ data: [] }),
    useDeviceManagerAdoptionRefresh: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    useDeviceManagerListAll: () => ({ data: [], isLoading: false }),
    useLocalNetworkGetScanSubnets: () => ({
      data: { subnets: [] },
      refetch: vi.fn(),
    }),
    useLocalNetworkSetScanSubnets: () => ({
      mutateAsync: vi.fn(),
      isPending: false,
    }),
    LogStream: () => null,
  }
})

import { AddDeviceModal } from '../AddDeviceModal'

type ModalProps = {
  kind?: 'device-adoption' | 'device-provider'
  canScan?: boolean | null
  integrationId?: string
}

function modalTree(props: ModalProps) {
  return (
    <MemoryRouter>
      <AddDeviceModal
        addonId="provider-esphome"
        integrationId={props.integrationId ?? 'int_1'}
        kind={props.kind ?? 'device-provider'}
        canScan={props.canScan === undefined ? true : props.canScan}
        onClose={vi.fn()}
      />
    </MemoryRouter>
  )
}

function renderModal(props: ModalProps = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrap = (p: ModalProps) => (
    <QueryClientProvider client={client}>{modalTree(p)}</QueryClientProvider>
  )
  const utils = render(wrap(props))
  return { ...utils, update: (next: ModalProps) => utils.rerender(wrap(next)) }
}

const adoptionEntry = (id: string, name: string) => ({
  childNativeId: id,
  name,
  alreadyAdopted: false,
  type: 'container',
  children: [],
})

describe('AddDeviceModal', () => {
  beforeEach(() => {
    state.creationType = DeviceType.Container
    state.schema = {
      sections: [
        {
          id: 's',
          fields: [
            { type: 'text', key: 'host', label: 'Host', required: true },
            {
              type: 'password',
              key: 'encryptionKey',
              label: 'API encryption key',
            },
          ],
        },
      ],
    }
    state.hubIntegrations = []
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

  it('hides the manual tab for the integration the provider refuses it for, keeps it for another', () => {
    state.hubIntegrations = ['int_hub']
    const hub = renderModal({ integrationId: 'int_hub' })
    expect(screen.queryByRole('tab', { name: 'Enter parameters' })).toBeNull()
    hub.unmount()
    renderModal({ integrationId: 'int_default' })
    expect(screen.getByRole('tab', { name: 'Enter parameters' })).toBeTruthy()
  })

  it('hides the manual tab when the provider declares a creation type but no field', () => {
    state.schema = { sections: [] }
    renderModal()
    expect(screen.queryByRole('tab', { name: 'Enter parameters' })).toBeNull()
  })

  it('lists a device once when the scan, a proposal and the adoption list all saw it', () => {
    state.scan = [hit('esp-attic', '192.0.2.10')]
    state.proposals = [
      {
        id: 'p1',
        addonId: 'provider-esphome',
        candidate: hit('esp-attic', '192.0.2.10'),
      },
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

  it('an adoption integration that can scan keeps the whole adopt surface and adds the scan', () => {
    state.adoption = [adoptionEntry('esp-cellar', 'cellar')]
    renderModal({ kind: 'device-adoption', canScan: true })
    expect(screen.getByRole('button', { name: /scan now/i })).toBeTruthy()
    expect(screen.getByPlaceholderText(/search candidates/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /refresh/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /add selected/i })).toBeTruthy()
  })

  it('a scan hit the adoption list already holds is not listed twice', () => {
    state.scan = [hit('esp-attic', '192.0.2.10'), hit('esp-new', '192.0.2.12')]
    state.adoption = [adoptionEntry('esp-attic', 'attic')]
    renderModal({ kind: 'device-adoption', canScan: true })
    const rows = screen.getAllByTestId(/^network-row-/)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-testid')).toBe('network-row-esp-new')
    expect(screen.getByText(/1 already in the list below/i)).toBeTruthy()
  })

  it('a scanned board that fails to add says so and never reads as added', async () => {
    state.scan = [hit('esp-new', '192.0.2.12')]
    state.adopt.mockRejectedValueOnce(new Error('board refused the key'))
    renderModal({ kind: 'device-adoption', canScan: true })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await waitFor(() => expect(screen.getByText('board refused the key')).toBeTruthy())
    expect(screen.queryByText(/^added$/i)).toBeNull()
    expect(state.adopt.mock.calls[0]?.[0]).toMatchObject({ integrationId: 'int_1' })
  })

  it('draws neither surface until the scan answer is in, so nothing remounts', () => {
    state.adoption = [adoptionEntry('esp-cellar', 'cellar')]
    const view = renderModal({ kind: 'device-adoption', canScan: null })
    expect(screen.queryByPlaceholderText(/search candidates/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /scan now/i })).toBeNull()
    view.update({ kind: 'device-adoption', canScan: true })
    expect(screen.getByPlaceholderText(/search candidates/i)).toBeTruthy()
    const search = screen.getByPlaceholderText(/search candidates/i)
    view.update({ kind: 'device-adoption', canScan: true })
    expect(screen.getByPlaceholderText(/search candidates/i)).toBe(search)
    expect(screen.getByRole('button', { name: /scan now/i })).toBeTruthy()
  })

  it('an adoption integration without a scan keeps the adoption list and no scan', () => {
    state.adoption = [adoptionEntry('esp-cellar', 'cellar')]
    renderModal({ kind: 'device-adoption', canScan: false })
    expect(screen.getByPlaceholderText(/search candidates/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /scan now/i })).toBeNull()
    expect(screen.queryAllByTestId(/^network-row-/)).toHaveLength(0)
  })

  it('ignores a proposal that belongs to another integration', () => {
    state.proposals = [
      {
        id: 'p1',
        addonId: 'provider-gree',
        candidate: hit('ac', '192.0.2.20'),
      },
    ]
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
    fireEvent.change(input as HTMLInputElement, {
      target: { value: 'SECRET' },
    })
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
