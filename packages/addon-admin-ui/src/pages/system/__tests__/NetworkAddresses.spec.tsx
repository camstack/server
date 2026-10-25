/**
 * The Network Addresses page: the Allowed addresses card and ONE Addresses
 * table. The notification-taps role is chosen only in that table (the CamStack
 * app link is a row there), so the page carries no separate notification-link
 * card and never asks the hub for the notification endpoint on its own.
 */
import type { HubAddressBook } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { NetworkAddressesPage } from '../NetworkAddresses'

const mocks = vi.hoisted(() => {
  const LAN = 'http://192.0.2.10:4480'
  const book: HubAddressBook = {
    rows: [],
    roles: {
      appConnections: { flagged: [], resolved: [LAN], source: 'auto' },
      notificationTaps: { flagged: null, resolved: 'https://camstack.zentik.app', source: 'auto' },
      internal: { flagged: null, resolved: LAN, source: 'auto' },
      publicEndpoint: { flagged: null, resolved: LAN, source: 'auto' },
    },
    appLinkHub: null,
  }
  const query =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, refetch: vi.fn() })
  const mutation = () => () => ({ mutate: vi.fn(), isPending: false, error: null })
  const getNotificationEndpoint = vi.fn(() => ({ data: undefined }))
  return { book, query, mutation, getNotificationEndpoint }
})

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useLocalNetworkList: mocks.query({ interfaces: [] }),
    useLocalNetworkGetAllowedAddresses: mocks.query({ addresses: [] }),
    useLocalNetworkGetAddresses: mocks.query(mocks.book),
    useLocalNetworkGetNotificationEndpoint: mocks.getNotificationEndpoint,
    useLocalNetworkSetAddressRole: mocks.mutation(),
    useLocalNetworkAddCustomAddress: mocks.mutation(),
    useLocalNetworkRemoveCustomAddress: mocks.mutation(),
    useLocalNetworkResetAllowlistToBestMatch: mocks.mutation(),
    useLocalNetworkSetAllowedAddresses: mocks.mutation(),
  }
})

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NetworkAddressesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('NetworkAddressesPage', () => {
  it('has one Addresses table and no separate notification-link card', () => {
    renderPage()
    expect(screen.getByText('Addresses')).toBeTruthy()
    expect(screen.getByText('Allowed addresses')).toBeTruthy()
    expect(screen.queryByText('Notification links')).toBeNull()
    expect(screen.queryByText(/Use default \(app link\)/)).toBeNull()
    expect(mocks.getNotificationEndpoint).not.toHaveBeenCalled()
  })

  it('explains the roles at the top of the Addresses table', () => {
    renderPage()
    const help = screen.getByTestId('address-roles-help')
    expect(help.textContent).toContain('What are roles?')
  })
})
