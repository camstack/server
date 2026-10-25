/**
 * Component tests for the Delivery History tab (slice D2).
 *
 * Verifies the THREE states are distinguishable: rows, empty (query succeeded
 * with zero rows), and unavailable (query errored → "requires server update").
 */
import type { NcHistoryEntry } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FleetListInput,
  type FleetListOptions,
  type FleetListResult,
  type FleetRow,
  fleetListResult,
} from './fleet-read-spy'

let mockHistoryImpl: () => Promise<{ entries: readonly NcHistoryEntry[] }> = () =>
  Promise.resolve({ entries: [] })

/** What the page sent — the filter is the whole assertion surface. */
interface HistoryCall {
  readonly filter: Readonly<Record<string, unknown>>
}

const mockGetHistory = vi.fn((_input: HistoryCall) => mockHistoryImpl())
const mockListRules = vi.fn(() =>
  Promise.resolve({
    rules: [
      { id: 'r1', name: 'Porta' },
      { id: 'r2', name: 'Garage' },
    ],
  }),
)
const mockListAll = vi.fn(() => Promise.resolve([]))

/** What the shared fleet query answers in these tests. */
const FLEET_ROWS: readonly FleetRow[] = [{ id: 7, name: 'Camera atrio', type: 'camera' }]

/** The generated fleet hook — the ONLY client these pages may read the fleet
 *  through. See `fleet-read-spy.ts` for what the assertion pins and why. */
const listAllHook = vi.fn(
  (_input?: FleetListInput, _options?: FleetListOptions): FleetListResult =>
    fleetListResult(FLEET_ROWS),
)

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useDeviceManagerListAll: (input?: FleetListInput, options?: FleetListOptions) =>
      listAllHook(input, options),
    useSystem: () => ({
      trpcClient: {
        notificationRules: {
          listRules: { query: mockListRules },
          getHistory: { query: mockGetHistory },
        },
        deviceManager: { listAll: { query: mockListAll } },
      },
    }),
  }
})

import { NotificationHistoryPage } from '../NotificationHistory'

/** Where the tab opened — the rules table links here with `?ruleId=`. */
function renderPage(url = '/system/notifications?tab=history') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <NotificationHistoryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function entry(overrides: Partial<NcHistoryEntry> = {}): NcHistoryEntry {
  return {
    id: 'o1',
    ruleId: 'r1',
    ruleName: 'Front door',
    delivery: 'track-end',
    targetId: 't1',
    deviceId: 7,
    recordKind: 'track-end',
    recordId: 'trk-1',
    status: 'sent',
    attempts: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    subject: { className: 'person', zones: [], timestamp: 1_700_000_000_000 },
    ...overrides,
  }
}

describe('NotificationHistory page', () => {
  beforeEach(() => {
    mockHistoryImpl = () => Promise.resolve({ entries: [] })
    mockGetHistory.mockClear()
    mockListRules.mockClear()
    mockListAll.mockClear()
    listAllHook.mockClear()
  })

  it('reads the fleet through the shared client, slim, and never through the raw tRPC client', () => {
    renderPage()
    expect(listAllHook).toHaveBeenCalled()
    for (const [input, options] of listAllHook.mock.calls) {
      expect(input?.projection).toBe('slim')
      // D274 owns the window on the query client; a call site that redeclares
      // it fails `scripts/check-fleet-query-defaults.ts`.
      expect(options?.staleTime).toBeUndefined()
    }
    // The raw client is the hole D274 does not close: a fleet read here rides
    // no shared window, no shared cache entry and no `[['deviceManager']]`
    // invalidation, so a rename never reaches this picker.
    expect(mockListAll).not.toHaveBeenCalled()
  })

  it('shows the EMPTY state when the query succeeds with no rows', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/No deliveries match/i)).toBeTruthy())
  })

  it('shows the UNAVAILABLE state (requires server update) when the query errors', async () => {
    mockHistoryImpl = () => Promise.reject(new Error('NOT_FOUND'))
    renderPage()
    await waitFor(() => expect(screen.getByText(/requires a server update/i)).toBeTruthy())
    // Must NOT be the empty state.
    expect(screen.queryByText(/No deliveries match/i)).toBeNull()
  })

  it('renders rows with a status badge and the dead-row error', async () => {
    mockHistoryImpl = () =>
      Promise.resolve({
        entries: [
          entry(),
          entry({ id: 'o2', status: 'dead', error: 'target rejected', attempts: 4 }),
        ],
      })
    renderPage()
    // Rule name appears in the Rule column and again as the notification title
    // when the row has no systemEvent — two rows ⇒ at least four hits.
    await waitFor(() => expect(screen.getAllByText('Front door').length).toBeGreaterThanOrEqual(2))
    // Device 7's NAME, resolved off the shared fleet query — not `Camera #7`.
    expect(screen.getAllByText('Camera atrio').length).toBeGreaterThan(0)
    expect(screen.getByText('sent')).toBeTruthy()
    expect(screen.getByText('dead')).toBeTruthy()
    expect(screen.getByText('target rejected')).toBeTruthy()
  })

  it('opens filtered on the rule the URL names, over everything the outbox keeps', async () => {
    renderPage('/system/notifications?tab=history&ruleId=r1')
    await waitFor(() => expect(mockGetHistory).toHaveBeenCalled())
    const first = mockGetHistory.mock.calls[0]
    expect(first?.[0].filter['ruleId']).toBe('r1')
    // Seeded from a rule: no 24 h cut — its last run may be days old.
    expect(first?.[0].filter['since']).toBeUndefined()
  })

  it('without a rule in the URL: every rule, the last 24 hours', async () => {
    renderPage()
    await waitFor(() => expect(mockGetHistory).toHaveBeenCalled())
    const first = mockGetHistory.mock.calls[0]
    expect(first?.[0].filter['ruleId']).toBeUndefined()
    expect(first?.[0].filter['since']).toEqual(expect.any(Number))
  })

  it('the rule filter still works after a URL seed', async () => {
    renderPage('/system/notifications?tab=history&ruleId=r1')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Garage' })).toBeTruthy())
    const select = screen.getByTestId('history-rule-filter')
    fireEvent.change(select, { target: { value: 'r2' } })
    await waitFor(() => {
      const last = mockGetHistory.mock.calls.at(-1)
      expect(last?.[0].filter['ruleId']).toBe('r2')
    })
  })
})
