/**
 * The simulate tab, end to end against a mocked hub.
 *
 * What this guards that the pure specs cannot: that the page actually MOUNTS
 * (it composes half a dozen catalogue-driven pickers, each of which fetches),
 * that it calls the real custom action with the addon id and action name the
 * hub registered, and that the payload it puts on the wire still omits an
 * untouched optional rather than sending it as zero.
 */
import { DeviceType, type NcRule } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FleetListInput,
  type FleetListOptions,
  type FleetListResult,
  type FleetRow,
  fleetListResult,
} from './fleet-read-spy'

const mockListAll = vi.fn(() =>
  Promise.resolve([{ id: 101, name: 'Front door', type: DeviceType.Camera, location: null }]),
)
const mockCatalog = vi.fn(() => Promise.resolve({ catalog: [] }))
const mockListRules = vi.fn(
  (): Promise<{ rules: readonly NcRule[] }> => Promise.resolve({ rules: [] }),
)
const mockListTargets = vi.fn(() => Promise.resolve([]))
const mockListZones = vi.fn(() => Promise.resolve([]))
const mockKindsBatch = vi.fn(() => Promise.resolve([{ deviceId: 101, kinds: [] }]))
const mockCustom = vi.fn((_input: unknown) =>
  Promise.resolve({
    recordId: 'synthetic:abc',
    origin: 'synthetic',
    delivery: 'immediate',
    candidates: 0,
    outcomes: [],
    still: 'live',
    notes: ['Nothing was listening.'],
  }),
)

/** What the shared fleet query answers in these tests. */
const FLEET_ROWS: readonly FleetRow[] = [
  { id: 101, name: 'Front door', type: DeviceType.Camera, location: null },
  { id: 42, name: 'Serratura front door', type: 'lock', location: 'Front door' },
]

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
        deviceManager: { listAll: { query: mockListAll } },
        notificationRules: {
          getConditionCatalog: { query: mockCatalog },
          listRules: { query: mockListRules },
        },
        notificationOutput: { listTargets: { query: mockListTargets } },
        zones: { listZones: { query: mockListZones } },
        pipelineAnalytics: { listEventKindsBatch: { query: mockKindsBatch } },
        addons: { custom: { mutate: mockCustom } },
      },
    }),
  }
})

import { NotificationSimulatePage } from '../NotificationSimulate'
import { clearSimulatePrefill } from '../notification-simulate.helpers'

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationSimulatePage />
    </QueryClientProvider>,
  )
}

describe('NotificationSimulate page', () => {
  beforeEach(() => {
    clearSimulatePrefill()
    mockCustom.mockClear()
  })

  it('cannot run until a camera is chosen', async () => {
    renderPage()
    const button = await screen.findByRole('button', { name: /Inject event/i })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('injects through the registered custom action and omits untouched optionals', async () => {
    renderPage()
    const camera = await screen.findByTestId('simulate-camera')
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    fireEvent.change(camera, { target: { value: '101' } })
    fireEvent.change(screen.getByTestId('simulate-trigger'), { target: { value: 'track-end' } })

    fireEvent.click(screen.getByRole('button', { name: /Inject event/i }))
    await waitFor(() => expect(mockCustom).toHaveBeenCalledTimes(1))

    const call = mockCustom.mock.calls[0]![0]
    expect(call).toMatchObject({ addonId: 'pipeline-analytics', action: 'nc.injectTestEvent' })
    const input = (call as { input: Record<string, unknown> }).input
    expect(input).toMatchObject({ trigger: 'track-end', deviceId: 101, still: 'live' })
    // Untouched optionals are ABSENT, not zero.
    expect(input).not.toHaveProperty('confidence')
    expect(input).not.toHaveProperty('importance')
    expect(input).not.toHaveProperty('dwellSeconds')
  })

  it('renders the answer, including a run where nothing was evaluated', async () => {
    renderPage()
    const camera = await screen.findByTestId('simulate-camera')
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    fireEvent.change(camera, { target: { value: '101' } })
    fireEvent.click(screen.getByRole('button', { name: /Inject event/i }))

    await waitFor(() => expect(screen.getByText('synthetic:abc')).toBeTruthy())
    expect(screen.getByText(/No enabled rule declares the "immediate" delivery/)).toBeTruthy()
    expect(screen.getByText('Nothing was listening.')).toBeTruthy()
  })
})

describe('the fleet read', () => {
  it('goes through the shared client, slim, and never through the raw tRPC client', () => {
    listAllHook.mockClear()
    mockListAll.mockClear()
    renderPage()
    expect(listAllHook).toHaveBeenCalled()
    for (const [input, options] of listAllHook.mock.calls) {
      expect(input?.projection).toBe('slim')
      // D274 owns the window on the query client; a call site that redeclares
      // it fails `scripts/check-fleet-query-defaults.ts`.
      expect(options?.staleTime).toBeUndefined()
    }
    // The raw client is the hole D274 does not close: a fleet read there rides
    // no shared window, no shared cache entry and no `[['deviceManager']]`
    // invalidation, so a rename never reaches this picker.
    expect(mockListAll).not.toHaveBeenCalled()
  })
})
