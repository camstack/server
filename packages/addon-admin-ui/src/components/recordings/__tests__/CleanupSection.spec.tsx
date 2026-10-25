/// <reference types="@testing-library/jest-dom" />

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityPresence } from '../../../lib/capability-presence'

expect.extend(jestDomMatchers)

let presence: CapabilityPresence = 'present'
let statusData: unknown = null
const startMutateAsync = vi.fn()
const confirmMock = vi.fn().mockResolvedValue(true)

vi.mock('../../../lib/capability-presence', () => ({
  useCapabilityPresence: () => presence,
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useConfirm: () => confirmMock,
    useStorageMigrationCleanupStart: () => ({
      mutateAsync: startMutateAsync,
      isPending: false,
    }),
    useStorageMigrationCleanupStatus: () => ({
      data: statusData,
      refetch: vi.fn().mockResolvedValue({ data: statusData }),
    }),
    useStorageMigrationCleanupCancel: () => ({
      mutateAsync: vi.fn(),
    }),
  }
})

import { CleanupSection } from '../CleanupSection'

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CleanupSection />
    </QueryClientProvider>,
  )
}

describe('CleanupSection', () => {
  afterEach(() => {
    vi.clearAllMocks()
    presence = 'present'
    statusData = null
  })

  it('starts cleanup without debug media by default', async () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Run cleanup' }))
    await waitFor(() => {
      expect(startMutateAsync).toHaveBeenCalledWith({ includeDebugMedia: false })
    })
  })

  it('passes the debug-media checkbox through', async () => {
    renderSection()
    fireEvent.click(screen.getByRole('checkbox', { name: /debug media/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Run cleanup' }))
    await waitFor(() => {
      expect(startMutateAsync).toHaveBeenCalledWith({ includeDebugMedia: true })
    })
  })

  it('shows live phase and counters without waiting on the pass', () => {
    statusData = {
      jobId: 'c1',
      phase: 'orphans',
      includeDebugMedia: false,
      orphansReclaimed: 12,
      orphanBytesReclaimed: 4096,
      debugMediaReclaimed: 0,
      debugMediaBytesReclaimed: 0,
      ghostsForgotten: 0,
      ghostBytesForgotten: 0,
      detail: 'Orphan reclaim: object-events',
      cancelRequested: false,
      startedAt: 1,
      updatedAt: 2,
      finishedAt: null,
      error: null,
    }
    renderSection()
    expect(screen.getByText(/orphans/)).toBeInTheDocument()
    expect(screen.getByText(/12 orphan rows/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })
})
