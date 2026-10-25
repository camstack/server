// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// --- mocks -----------------------------------------------------------------
// The State panel renders only caps that appear in the whole-system snapshot
// or the live stream — so a doorbell-capable device whose `doorbell` slice was
// never written (never rung) shows NOTHING. This spec drives the fix: the
// panel must ALSO surface a placeholder entry for every BOUND cap that
// declares a `runtimeState` slice, so the operator SEES the doorbell ("never")
// on a camera that has the cap. We mock the snapshot, live subscription, the
// device-bindings query (the new dependency), the DeviceProxy (raw state), and
// the system context.

interface SnapshotQueryResult {
  readonly data: Record<string, Record<string, Record<string, unknown>>> | undefined
  readonly isLoading: boolean
}

interface BindingsEntry {
  readonly capName: string
  readonly kind: string
  readonly providerAddonId: string
  readonly providerNodeId: string
  readonly nativeAddonId: string
}
interface BindingsQueryResult {
  readonly data:
    | { readonly deviceId: number; readonly entries: readonly BindingsEntry[] }
    | undefined
}

let snapshotResult: SnapshotQueryResult
let bindingsResult: BindingsQueryResult

const getAllSnapshotsUseQuery = vi.fn(() => snapshotResult)
const getBindingsUseQuery = vi.fn(() => bindingsResult)
const subscribeUseSubscription = vi.fn((): void => undefined)

vi.mock('../../trpc-react', () => ({
  trpc: {
    deviceState: {
      getAllSnapshots: { useQuery: () => getAllSnapshotsUseQuery() },
    },
    deviceManager: {
      getBindings: { useQuery: () => getBindingsUseQuery() },
    },
    systemEvents: {
      subscribe: { useSubscription: () => subscribeUseSubscription() },
    },
  },
}))

vi.mock('../../contexts/system-context', () => ({
  useSystem: () => ({ trpcClient: {} }),
}))

vi.mock('../../hooks/use-device-proxy', () => ({
  useDeviceProxy: vi.fn(() => null),
}))

// Imported AFTER the mocks are declared (vi.mock is hoisted regardless).
import { StateValuesStream } from '../state-values-stream'

const DEVICE_ID = 101

/** A composed doorbell's binding, as `getBindings` answers it for camera 101 (D671). */
function doorbellBinding(): BindingsEntry {
  return {
    capName: 'doorbell',
    kind: 'native',
    providerAddonId: 'composer',
    providerNodeId: 'hub',
    nativeAddonId: 'composer',
  }
}

function renderWithClient(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('StateValuesStream — bound runtimeState caps surface even with an empty slice', () => {
  beforeEach(() => {
    getAllSnapshotsUseQuery.mockClear()
    getBindingsUseQuery.mockClear()
    subscribeUseSubscription.mockClear()
    snapshotResult = { data: {}, isLoading: false }
    bindingsResult = { data: { deviceId: DEVICE_ID, entries: [doorbellBinding()] } }
  })

  it('renders a doorbell entry ("never" — lastPressedAt null) for a doorbell-capable device with NO slice', async () => {
    // Snapshot has no state for this device — doorbell never rang.
    snapshotResult = { data: {}, isLoading: false }

    renderWithClient(<StateValuesStream deviceId={DEVICE_ID} />)

    // The doorbell cap must appear even though its slice was never written.
    await waitFor(() => expect(screen.getByText('doorbell')).toBeTruthy())
    // The runtimeState fields are surfaced as the cold "never" placeholder.
    expect(screen.getByText('lastPressedAt')).toBeTruthy()
    // The "No runtime state" empty state must NOT show — we have the doorbell.
    expect(screen.queryByText('No runtime state')).toBeNull()
  })

  it('replaces the cold placeholder when the snapshot lands AFTER the bindings', async () => {
    // THE RACE. `getBindings` and `getAllSnapshots` are independent queries.
    // When bindings win, every bound cap is filled with an all-null cold
    // placeholder — and the snapshot seed used to skip on mere presence
    // (`if (next.has(capName)) continue`), so the real values never landed.
    // On a device that emits no live patches (a sleeping battery camera)
    // the panel then stayed all-null forever, while the same data rendered
    // correctly everywhere else in the app.
    snapshotResult = { data: undefined, isLoading: true }
    bindingsResult = { data: { deviceId: DEVICE_ID, entries: [doorbellBinding()] } }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <StateValuesStream deviceId={DEVICE_ID} />
      </QueryClientProvider>,
    )

    // Placeholder is in place: the cap shows, its field reads "never".
    await waitFor(() => expect(screen.getByText('doorbell')).toBeTruthy())
    expect(screen.getByText('lastPressedAt')).toBeTruthy()
    expect(screen.queryByText('12345')).toBeNull()

    // Snapshot arrives late — it MUST overwrite the placeholder.
    snapshotResult = {
      data: {
        [String(DEVICE_ID)]: { doorbell: { lastPressedAt: 12345, pressCountSinceStart: 2 } },
      },
      isLoading: false,
    }
    rerender(
      <QueryClientProvider client={qc}>
        <StateValuesStream deviceId={DEVICE_ID} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText('12345')).toBeTruthy())
  })

  it('renders the populated doorbell slice (lastPressedAt) when it HAS rung', async () => {
    snapshotResult = {
      data: {
        [String(DEVICE_ID)]: { doorbell: { lastPressedAt: 12345, pressCountSinceStart: 2 } },
      },
      isLoading: false,
    }

    renderWithClient(<StateValuesStream deviceId={DEVICE_ID} />)

    await waitFor(() => expect(screen.getByText('doorbell')).toBeTruthy())
    expect(screen.getByText('lastPressedAt')).toBeTruthy()
    expect(screen.getByText('12345')).toBeTruthy()
  })
})
