// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// --- mocks -----------------------------------------------------------------
// `StateValuesStream` reads the whole-system snapshot + the live subscription
// off the shared React `trpc` proxy (`../../trpc-react`), but it now fetches
// the device's RAW upstream state through the DeviceProxy — `device-ops` is a
// device-scoped cap living in the device's owning (forked) runner, so a direct
// `trpc.deviceOps.getRawState.useQuery({ deviceId })` routes to
// `hub-in-process` and fails. The proxy resolves the device's binding and
// routes the imperative `dev.deviceOps.getRawState({ deviceId })` to the
// owning node. We therefore mock `useDeviceProxy` (the routing path) and
// `useSystem` (the vanilla client source), and drive the real `@tanstack/
// react-query` `useQuery` the component wraps the imperative call in.

interface SnapshotQueryResult {
  readonly data: Record<string, Record<string, Record<string, unknown>>> | undefined
  readonly isLoading: boolean
}

/** Shape returned by the proxy's `dev.deviceOps.getRawState`. */
type RawStateBlob = { source: string; data: Record<string, unknown> } | null

let snapshotResult: SnapshotQueryResult
/** What the mocked `dev.deviceOps.getRawState` imperative call resolves to. */
let rawBlob: RawStateBlob
/** When false, the proxy exposes no `deviceOps.getRawState` (no device-ops binding). */
let rawAvailable: boolean

const getAllSnapshotsUseQuery = vi.fn(() => snapshotResult)
const subscribeUseSubscription = vi.fn((): void => undefined)
const getRawStateSpy = vi.fn(async (): Promise<RawStateBlob> => rawBlob)

vi.mock('../../trpc-react', () => ({
  trpc: {
    deviceState: {
      getAllSnapshots: { useQuery: () => getAllSnapshotsUseQuery() },
    },
    // The panel seeds cold placeholders for bound runtimeState caps via the
    // device-bindings query — no bindings here (empty entries) so the raw
    // toggle behaviour under test is unaffected.
    deviceManager: {
      getBindings: { useQuery: () => ({ data: { deviceId: 1, entries: [] } }) },
    },
    systemEvents: {
      subscribe: { useSubscription: () => subscribeUseSubscription() },
    },
  },
}))

vi.mock('../../contexts/system-context', () => ({
  // The component only reads `system.trpcClient` to hand it to
  // `useDeviceProxy`, which is itself mocked — so an empty object suffices.
  useSystem: () => ({ trpcClient: {} }),
}))

vi.mock('../../hooks/use-device-proxy', () => ({
  useDeviceProxy: vi.fn(() =>
    rawAvailable ? { deviceOps: { getRawState: getRawStateSpy } } : null,
  ),
}))

// Imported AFTER the mocks are declared (vi.mock is hoisted regardless).
import { StateValuesStream } from '../state-values-stream'

function renderWithClient(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('StateValuesStream — Normalized | Raw toggle', () => {
  beforeEach(() => {
    getAllSnapshotsUseQuery.mockClear()
    subscribeUseSubscription.mockClear()
    getRawStateSpy.mockClear()
    snapshotResult = { data: { '1': { switch: { on: true } } }, isLoading: false }
    rawBlob = null
    rawAvailable = false
  })

  it('renders the Raw toggle and shows raw data when getRawState resolves a blob', async () => {
    rawAvailable = true
    rawBlob = {
      source: 'homeassistant',
      data: { state: 'on', attributes: { supported_features: 1 } },
    }

    renderWithClient(<StateValuesStream deviceId={1} />)

    // The proxy-routed query resolves asynchronously — wait for the toggle.
    const rawToggle = await screen.findByRole('button', { name: /^Raw$/ })
    expect(rawToggle).toBeTruthy()

    fireEvent.click(rawToggle)

    // The raw blob's top-level keys become tree nodes; expanding shows the
    // nested attribute keys.
    expect(screen.getByText('state')).toBeTruthy()
    expect(screen.getByText('attributes')).toBeTruthy()
    expect(screen.getByText(/supported_features/)).toBeTruthy()
    // Source is surfaced somewhere in the raw view.
    expect(screen.getByText(/homeassistant/)).toBeTruthy()
  })

  it('does NOT render the Raw toggle when getRawState resolves null', async () => {
    rawAvailable = true
    rawBlob = null

    renderWithClient(<StateValuesStream deviceId={1} />)

    await waitFor(() => expect(getRawStateSpy).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /^Raw$/ })).toBeNull()
  })

  it('does NOT render the Raw toggle when the device exposes no device-ops cap', () => {
    rawAvailable = false

    renderWithClient(<StateValuesStream deviceId={1} />)

    expect(screen.queryByRole('button', { name: /^Raw$/ })).toBeNull()
    expect(getRawStateSpy).not.toHaveBeenCalled()
  })

  it('Refresh button triggers refetch in raw mode', async () => {
    rawAvailable = true
    rawBlob = { source: 'reolink', data: { battery: 80 } }

    renderWithClient(<StateValuesStream deviceId={1} />)

    fireEvent.click(await screen.findByRole('button', { name: /^Raw$/ }))
    // First call is the initial fetch; Refresh triggers a second one.
    getRawStateSpy.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))

    await waitFor(() => expect(getRawStateSpy).toHaveBeenCalledTimes(1))
  })
})
