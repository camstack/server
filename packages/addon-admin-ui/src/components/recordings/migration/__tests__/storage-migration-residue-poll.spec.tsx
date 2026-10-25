/**
 * The residue census is OPERATOR-DRIVEN. No timer may start one.
 *
 * `storageMigration.residue` reaches `pipelineAnalytics.countRelocatableMedia`,
 * which walks the whole 1.26 M-row `media` collection twice plus
 * `retrain-frames` once — ~12 600 store round trips per answer. This component
 * asked for one every ten seconds, and the walk had no stop signal, so the
 * censuses accumulated instead of replacing each other: measured 2026-08-31 at
 * 88.7 % of the settings engine's wall clock, ~500 walks in flight, and a
 * ~16 s FIFO queue in front of EVERY store call in the cluster.
 *
 * So the assertions here are about the SHAPE of the request, not about
 * rendering: what options the query is given, and what the operator can press.
 * A test that only checked the rendered rows would pass against the polling
 * version — the rows were never wrong.
 */

/// <reference types="@testing-library/jest-dom" />

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * The residue census is OPERATOR-DRIVEN. No timer may start one.
 *
 * `storageMigration.residue` reaches `pipelineAnalytics.countRelocatableMedia`,
 * which walks the whole 1.26 M-row `media` collection twice plus
 * `retrain-frames` once — ~12 600 store round trips per answer. This component
 * asked for one every ten seconds, and the walk had no stop signal, so the
 * censuses accumulated instead of replacing each other: measured 2026-08-31 at
 * 88.7 % of the settings engine's wall clock, ~500 walks in flight, and a
 * ~16 s FIFO queue in front of EVERY store call in the cluster.
 *
 * So the assertions here are about the SHAPE of the request, not about
 * rendering: what options the query is given, and what the operator can press.
 * A test that only checked the rendered rows would pass against the polling
 * version — the rows were never wrong.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityPresence } from '../../../../lib/capability-presence'

expect.extend(jestDomMatchers)

const presence: CapabilityPresence = 'present'

/** Every options object `useStorageMigrationResidue` was called with. */
const residueOptions: unknown[] = []
const residueRefetchMock = vi.fn().mockResolvedValue({ data: [] })
let residueData: unknown[] = []
let residueIsFetching = false
let residueUpdatedAt = 0

const RESIDUE_ENTRY = {
  storageClass: 'eventMedia',
  fromLocationId: '*',
  toLocationId: 'eventMedia:ssd',
  items: null,
  bytes: null,
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useStorageListLocations: () => ({ data: [], isLoading: false }),
    useConfirm: () => vi.fn().mockResolvedValue(true),
    useStorageMigrationPlan: () => ({ data: undefined, isFetching: false, refetch: vi.fn() }),
    useStorageMigrationStart: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useStorageMigrationStatus: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
    useStorageMigrationCancel: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useStorageMigrationResidue: (_input: unknown, options: unknown) => {
      residueOptions.push(options)
      return {
        data: residueData,
        isLoading: false,
        isFetching: residueIsFetching,
        dataUpdatedAt: residueUpdatedAt,
        refetch: residueRefetchMock,
      }
    },
    useStorageMigrationDrain: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useStorageMigrationMovers: () => ({ data: [], isLoading: false }),
    // Added to the section after this spec was written. Every hook here is a
    // tRPC query, and one left unmocked does not fail as a missing row — it
    // throws "Unable to find tRPC Context" and takes all six assertions with
    // it, naming none of them. That is what happened.
    useStorageMigrationHistory: () => ({ data: [], isLoading: false }),
  }
})

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

/** The one option key that turns a whole-collection walk into a runaway. */
function refetchIntervalsAskedFor(): unknown[] {
  return residueOptions
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .map((o) => o['refetchInterval'])
    .filter((v) => v !== undefined)
}

describe('StorageMigrationSection — the residue census is not on a timer', () => {
  beforeEach(() => {
    residueOptions.length = 0
    residueData = [RESIDUE_ENTRY]
    residueIsFetching = false
    residueUpdatedAt = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('never asks for a refetch interval on the census', () => {
    renderSection()
    expect(residueOptions.length).toBeGreaterThan(0)
    expect(refetchIntervalsAskedFor()).toEqual([])
  })

  it('does not let a window regaining focus start one either', () => {
    renderSection()
    const [options] = residueOptions
    expect(options).toMatchObject({ refetchOnWindowFocus: false })
  })

  /** Removing the timer without giving the operator a way to re-ask would trade
   *  a runaway for a number nobody can refresh. */
  it('gives the operator a Refresh that takes exactly one census', async () => {
    renderSection()
    const button = screen.getByRole('button', { name: /refresh/i })
    fireEvent.click(button)
    await waitFor(() => {
      expect(residueRefetchMock).toHaveBeenCalledTimes(1)
    })
  })

  /** A second press while one is in flight must not start a second walk — that
   *  is the accumulation, by hand. */
  it('refuses a second press while a census is still running, and says it is running', () => {
    residueIsFetching = true
    renderSection()
    const button = screen.getByRole('button', { name: /counting/i })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(residueRefetchMock).not.toHaveBeenCalled()
  })

  /** A number with no timestamp reads as "now". This one can be hours old. */
  it('says when the number was taken', () => {
    residueUpdatedAt = Date.parse('2026-08-31T07:02:41Z')
    renderSection()
    expect(screen.getByText(/measured/i)).toBeInTheDocument()
  })

  /** D295, unchanged: an unanswerable census is listed and worded as unknown —
   *  it is never rendered as zero, and never dropped. */
  it('still lists a residue the census could not measure', () => {
    residueData = [RESIDUE_ENTRY]
    renderSection()
    expect(screen.getByText(/amount unknown/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Drain remaining' })).toBeInTheDocument()
  })
})
