/**
 * The provider-instances panel: one row per instance of every provider that holds records,
 * a fixed row (with its registry switch) for a provider that has none, and three different
 * answers for loading, failed and empty. Only the cap hooks and the tRPC client are stubbed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { Mail } from 'lucide-react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface ProviderRow {
  addonId: string
  isActive: boolean
}

const h = vi.hoisted(() => ({
  fn: { data: [] as ProviderRow[] | undefined, error: null as Error | null },
  holders: {
    data: [] as ProviderRow[] | undefined,
    error: null as Error | null,
  },
  records: {} as Record<string, unknown[]>,
  describeFails: false,
  setEnabled: vi.fn(),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const query = (slot: { data: ProviderRow[] | undefined; error: Error | null }) => ({
    data: slot.data,
    error: slot.error,
    isPending: slot.data === undefined && slot.error === null,
    isError: slot.error !== null,
    refetch: vi.fn(),
  })
  return {
    ...actual,
    useAddonsListCapabilityProviders: (input: { capName: string }) =>
      query(input.capName === 'integration-instances' ? h.holders : h.fn),
    useAddonsList: () => ({
      data: [
        {
          manifest: {
            id: 'winston-logging',
            name: 'Winston',
            description: 'Rotated files',
          },
        },
        { manifest: { id: 'loki-logging', name: 'Loki' } },
        { manifest: { id: 'smtp-nodemailer', name: 'SMTP' } },
      ],
    }),
    useAddonsSetCapabilityProviderEnabled: () => ({
      mutate: h.setEnabled,
      isPending: false,
    }),
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          describe: {
            query: async ({ addonId }: { addonId: string }) => {
              if (h.describeFails) throw new Error('describe failed')
              return {
                instanceMode: addonId === 'loki-logging' ? 'single' : 'multiple',
                kind: 'x',
                canTest: true,
              }
            },
          },
          listInstances: {
            query: async ({ addonId }: { addonId: string }) => h.records[addonId],
          },
        },
      },
    }),
  }
})

import { ProviderInstancesPanel } from '../ProviderInstancesPanel'

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProviderInstancesPanel
          functionCap="log-destination"
          icon={Mail}
          title="Destinations"
          subtitle="Every destination."
          emptyTitle="Nothing configured"
          emptyDescription="Add one."
          addLabel="Add destination"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  h.fn = { data: [], error: null }
  h.holders = { data: [], error: null }
  h.records = {}
  h.describeFails = false
  h.setEnabled.mockReset()
})

describe('ProviderInstancesPanel', () => {
  it('lists an instance row per record of two providers, and a fixed row with a switch', async () => {
    h.fn.data = [
      { addonId: 'winston-logging', isActive: true },
      { addonId: 'loki-logging', isActive: true },
      { addonId: 'smtp-nodemailer', isActive: true },
    ]
    h.holders.data = [
      { addonId: 'loki-logging', isActive: true },
      { addonId: 'smtp-nodemailer', isActive: true },
    ]
    h.records = {
      'loki-logging': [
        {
          id: 'loki-logging',
          name: 'Loki prod',
          configured: true,
          formValues: {},
        },
      ],
      'smtp-nodemailer': [
        {
          id: 'relay-default',
          name: 'Default relay',
          configured: true,
          formValues: {},
        },
        {
          id: 'inst-aaaaaaaa',
          name: 'Office relay',
          configured: false,
          formValues: {},
        },
      ],
    }
    renderPanel()
    expect(await screen.findByText('Loki prod')).toBeTruthy()
    expect(screen.getByText('Default relay')).toBeTruthy()
    expect(screen.getByText('Office relay')).toBeTruthy()
    expect(screen.getByText('Not configured')).toBeTruthy()
    expect(screen.getByText('Rotated files')).toBeTruthy()
    // Only the fixed row (Winston) carries the registry switch.
    expect(screen.getAllByRole('switch')).toHaveLength(1)
  })

  it('shows no empty text while a query is still unanswered', () => {
    h.fn.data = undefined
    renderPanel()
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('Nothing configured')).toBeNull()
  })

  it('shows the empty state only once every query answered with nothing', async () => {
    renderPanel()
    expect(await screen.findByText('Nothing configured')).toBeTruthy()
  })

  it('shows an error box, not the empty state, when a query failed', async () => {
    h.fn.data = [{ addonId: 'loki-logging', isActive: true }]
    h.holders.data = [{ addonId: 'loki-logging', isActive: true }]
    h.describeFails = true
    renderPanel()
    await waitFor(() => expect(screen.getByText('Could not load the list')).toBeTruthy())
    expect(screen.getByText('describe failed')).toBeTruthy()
    expect(screen.queryByText('Nothing configured')).toBeNull()
  })
})
