/// <reference types="@testing-library/jest-dom" />

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * StorageMigrationSection — capability gate + core interaction.
 *
 * `storage-migration` is a `system`-scope singleton builtin (always
 * registered — see `packages/system/src/builtins/storage-orchestrator`),
 * wired into `@camstack/ui-library`'s generated hooks (`useStorageMigrationPlan`
 * / `useStorageMigrationStart` / `useStorageMigrationStatus` /
 * `useStorageMigrationCancel`). This file pins:
 *   1. the SETTLED halves of the runtime gate — an `absent` answer renders
 *      the EmptyState, a `present` answer renders the panel,
 *   2. the plan → start round trip once available, wired through the real
 *      generated hooks (mocked directly, matching each hook's actual
 *      contract: `plan`/`status` are query-shaped with `refetch`, `start`/
 *      `cancel` are mutation-shaped with `mutateAsync`).
 *
 * The UNSETTLED halves — `pending` must never render the absent copy, and the
 * gate must cost one targeted registry read rather than the cluster topology
 * fan-out — cannot be pinned here, and that is the point: this file MOCKS the
 * gate, and a mocked gate is never pending and never sends a request. A fake
 * that supplies the settled answer is exactly how the lie survived review.
 * Those two live in `storage-migration-presence.spec.tsx`, which drives the
 * real tRPC client and records the operations it actually sends.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityPresence } from '../../../../lib/capability-presence'

expect.extend(jestDomMatchers)

// `isDefault` is gone (D383): `enabled` is the write set, so the sole enabled
// row of a type is what makes `recordings:default` the auto-picked source
// below — `recordings:nas` starts disabled to give the test the contrast.
const LOCATIONS = [
  {
    id: 'recordings:default',
    type: 'recordings',
    displayName: 'Default recordings',
    providerId: 'fs',
    config: {},
    enabled: true,
    isSystem: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'recordings:nas',
    type: 'recordings',
    displayName: 'NAS recordings',
    providerId: 'fs',
    config: {},
    enabled: false,
    isSystem: false,
    createdAt: 0,
    updatedAt: 0,
  },
]

let presence: CapabilityPresence = 'absent'
let statusData: unknown = null
let residueData: unknown[] = []
let moversData: unknown[] = []

const planRefetchMock = vi.fn()
const startMutateAsyncMock = vi.fn()
const statusRefetchMock = vi.fn().mockResolvedValue({ data: null })
const cancelMutateAsyncMock = vi.fn()
const confirmMock = vi.fn().mockResolvedValue(true)
const residueRefetchMock = vi.fn().mockResolvedValue({ data: [] })
const drainMutateAsyncMock = vi.fn()

/** A mover's counters at one instant. Both timestamps are the hub's. */
function progress(filesMoved: number, elapsedMs: number, filesTotal: number | null = 136_885) {
  return {
    filesMoved,
    filesTotal,
    bytesMoved: filesMoved * 700_000,
    startedAt: 1_000_000,
    observedAt: 1_000_000 + elapsedMs,
  }
}

function drainingJob(filesMoved: number, elapsedMs: number, filesTotal: number | null = 136_885) {
  return {
    jobId: 'job-1',
    phase: 'draining',
    mode: 'nonBlocking',
    destinations: { recordingsLow: 'recordingsLow:ssd' },
    throttleMbps: 40,
    moves: [
      {
        storageClass: 'recordingsLow',
        fromLocationId: 'recordingsLow:default',
        toLocationId: 'recordingsLow:ssd',
        moverJobId: 'cefb41c2',
        state: 'running',
        error: null,
        progress: progress(filesMoved, elapsedMs, filesTotal),
      },
    ],
    pauseLeaseId: null,
    pausedParticipants: [],
    repointed: true,
    cancelRequested: false,
    startedAt: 1_000_000,
    updatedAt: 1_000_000,
    finishedAt: null,
    error: null,
  }
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useStorageListLocations: () => ({ data: LOCATIONS, isLoading: false }),
    useConfirm: () => confirmMock,
    // Query-shaped generated hook (`typeof trpc.storageMigration.plan.useQuery`):
    // called with `enabled: false` and driven on-demand via `refetch()`.
    useStorageMigrationPlan: (input: unknown) => ({
      data: undefined,
      isFetching: false,
      refetch: () => planRefetchMock(input),
    }),
    // Mutation-shaped generated hook (`typeof trpc.storageMigration.start.useMutation`).
    useStorageMigrationStart: () => ({
      mutateAsync: startMutateAsyncMock,
      isPending: false,
    }),
    // Query-shaped generated hook (`typeof trpc.storageMigration.status.useQuery`),
    // polled every 2s in the real component.
    useStorageMigrationStatus: () => ({
      data: statusData,
      isLoading: false,
      refetch: statusRefetchMock,
    }),
    // Mutation-shaped generated hook (`typeof trpc.storageMigration.cancel.useMutation`).
    useStorageMigrationCancel: () => ({
      mutateAsync: cancelMutateAsyncMock,
      isPending: false,
    }),
    // The census behind "Drain remaining" — a ledger aggregate, polled.
    useStorageMigrationResidue: () => ({
      data: residueData,
      isLoading: false,
      refetch: residueRefetchMock,
    }),
    useStorageMigrationDrain: () => ({
      mutateAsync: drainMutateAsyncMock,
      isPending: false,
    }),
    useStorageMigrationMovers: () => ({ data: moversData, isLoading: false }),
    useStorageMigrationHistory: () => ({ data: [], isLoading: false }),
  }
})

// The gate, held at a SETTLED value. `pending` and `unknown` are deliberately
// not exercised from here — see the header.
vi.mock('../../../../lib/capability-presence', () => ({
  useCapabilityPresence: (): CapabilityPresence => presence,
}))

import { StorageMigrationSection } from '../StorageMigrationSection'

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <StorageMigrationSection />
    </QueryClientProvider>,
  )
}

describe('StorageMigrationSection — capability gate', () => {
  afterEach(() => {
    vi.clearAllMocks()
    presence = 'absent'
    statusData = null
    residueData = []
    moversData = []
  })

  it('shows an EmptyState once the registry has answered that nothing provides it', () => {
    presence = 'absent'
    renderSection()
    expect(screen.getByText('Storage migration not installed')).toBeInTheDocument()
    expect(screen.queryByText('Storage migration')).not.toBeInTheDocument()
  })

  it('renders the panel once the registry answers that something provides it', () => {
    presence = 'present'
    renderSection()
    expect(screen.getByText('Storage migration')).toBeInTheDocument()
    expect(screen.queryByText('Storage migration not installed')).not.toBeInTheDocument()
  })
})

describe('StorageMigrationSection — plan / start', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('plans then starts a migration against the selected destination', async () => {
    presence = 'present'
    statusData = null
    planRefetchMock.mockResolvedValue({
      data: {
        destinations: { recordings: 'recordings:nas' },
        moves: [
          {
            storageClass: 'recordings',
            fromLocationId: 'recordings:default',
            toLocationId: 'recordings:nas',
          },
        ],
      },
      error: null,
    })
    startMutateAsyncMock.mockResolvedValue({ jobId: 'job-1' })

    renderSection()

    const recordingsSelect = screen.getByLabelText('Recordings to') as HTMLSelectElement
    fireEvent.change(recordingsSelect, { target: { value: 'recordings:nas' } })

    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    await waitFor(() => {
      expect(planRefetchMock).toHaveBeenCalledWith({
        destinations: { recordings: 'recordings:nas' },
        sources: { recordings: 'recordings:default' },
      })
    })
    expect(await screen.findByText(/recordings:default.*recordings:nas/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Start migration' }))
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalled()
      expect(startMutateAsyncMock).toHaveBeenCalledWith({
        destinations: { recordings: 'recordings:nas' },
        sources: { recordings: 'recordings:default' },
      })
    })
  })

  it('disables Plan/Start until a destination is selected', () => {
    presence = 'present'
    statusData = null
    renderSection()
    expect(screen.getByRole('button', { name: 'Plan' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Start migration' })).toBeDisabled()
  })
})

/**
 * The mover, made visible.
 *
 * The assertion that matters is that the number MOVES: a fixture whose counters
 * never change would be satisfied by a panel that rendered a hard-coded zero,
 * or by one that rendered `filesTotal` twice. So this renders two consecutive
 * polls of a genuinely working drain and pins that the reading changed.
 */
describe('StorageMigrationSection — mover progress', () => {
  afterEach(() => {
    vi.clearAllMocks()
    statusData = null
    residueData = []
    moversData = []
  })

  it('shows a moving count, and it advances between polls', () => {
    presence = 'present'
    statusData = drainingJob(3_588, 600_000)
    const first = renderSection()
    expect(screen.getByText(/3,588 \/ 136,885 files/)).toBeInTheDocument()
    first.unmount()

    statusData = drainingJob(7_200, 1_200_000)
    renderSection()
    expect(screen.getByText(/7,200 \/ 136,885 files/)).toBeInTheDocument()
    expect(screen.queryByText(/3,588 \/ 136,885 files/)).not.toBeInTheDocument()
  })

  it('shows a rate and an estimate rather than only a phase', () => {
    presence = 'present'
    statusData = drainingJob(3_588, 600_000)
    renderSection()
    // 3 588 × 700 000 B over 600 s ≈ 4.0 MB/s, and 133 297 files left at
    // 5.98 files/s is a bit over six hours.
    expect(screen.getByText(/MB\/s/)).toBeInTheDocument()
    expect(screen.getByText(/left/)).toBeInTheDocument()
  })

  it('offers Cancel while draining — the long half is not uncancellable', () => {
    presence = 'present'
    statusData = drainingJob(1, 1_000)
    renderSection()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('renders a count without a denominator rather than a false 100%', () => {
    presence = 'present'
    statusData = drainingJob(500, 60_000, null)
    renderSection()
    // No denominator anywhere on the line, and no invented one either.
    expect(screen.getByText(/^500 files ·/)).toBeInTheDocument()
    expect(screen.queryByText(/136,885/)).not.toBeInTheDocument()
  })

  it('shows a mover no migration armed', () => {
    presence = 'present'
    moversData = [
      {
        lane: 'footage',
        migrationJobId: null,
        observedAt: 1_600_000,
        job: {
          jobId: 'cefb41c2',
          state: 'running',
          fromLocationId: 'recordingsLow:default',
          toLocationId: 'recordingsLow:ssd',
          deviceId: null,
          entities: ['segments'],
          filesMoved: 3_588,
          bytesMoved: 2_505_552_556,
          filesTotal: 136_885,
          startedAt: 1_000_000,
          finishedAt: null,
          error: null,
        },
      },
    ]
    renderSection()
    expect(screen.getByText('Movers running outside a migration')).toBeInTheDocument()
    expect(screen.getByText(/3,588 \/ 136,885 files/)).toBeInTheDocument()
  })
})

/**
 * The resume, offered only when there is genuinely something to resume.
 *
 * `residue` is a ledger census. An empty one means the source is empty, and the
 * action must not appear at all — an always-visible "drain" button is the
 * hopeful version of exactly the claim D295 was written about.
 */
describe('StorageMigrationSection — drain remaining', () => {
  afterEach(() => {
    vi.clearAllMocks()
    statusData = null
    residueData = []
    moversData = []
  })

  it('offers the resume when the source still holds footage', async () => {
    presence = 'present'
    residueData = [
      {
        storageClass: 'recordingsLow',
        fromLocationId: 'recordingsLow:default',
        toLocationId: 'recordingsLow:ssd',
        items: 145_664,
        bytes: 80_300_000_000,
      },
    ]
    drainMutateAsyncMock.mockResolvedValue({ jobId: 'drain-1' })
    renderSection()
    expect(screen.getByText(/145,664 segments/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Drain remaining' }))
    await waitFor(() => {
      expect(drainMutateAsyncMock).toHaveBeenCalledWith({ classes: ['recordingsLow'] })
    })
  })

  it('offers nothing when the source is empty', () => {
    presence = 'present'
    residueData = []
    renderSection()
    expect(screen.queryByText('Left on the old location')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Drain remaining' })).not.toBeInTheDocument()
  })

  it('says the amount is unknown rather than showing a zero', () => {
    presence = 'present'
    residueData = [
      {
        storageClass: 'recordingsLow',
        fromLocationId: 'recordingsLow:default',
        toLocationId: 'recordingsLow:ssd',
        items: null,
        bytes: null,
      },
    ]
    renderSection()
    expect(screen.getByText(/amount unknown/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Drain remaining' })).toBeInTheDocument()
  })
})
