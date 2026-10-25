/**
 * DiskReconcileSection — Recordings → Management disk-wins action.
 * Starts the fleet job on the hub and polls status; the walk is not
 * driven from the browser.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.fn()
const start = vi.fn()
const refetch = vi.fn()
const invalidateQueries = vi.fn()

let job: {
  state: 'idle' | 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: readonly number[]
  mediaDropped: number
  tracks: number
  events: number
  error: string | null
  finishedAtMs: number | null
}

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}))

vi.mock('@camstack/ui-library', () => ({
  useConfirm: () => confirm,
  usePipelineOrchestratorReconcileFromDisk: () => ({ mutateAsync: start, isPending: false }),
  usePipelineOrchestratorGetReconcileFromDiskStatus: () => ({ data: job, refetch }),
}))

import { DiskReconcileSection } from '../DiskReconcileSection'

describe('DiskReconcileSection', () => {
  beforeEach(() => {
    confirm.mockReset()
    start.mockReset()
    refetch.mockReset()
    invalidateQueries.mockReset()
    confirm.mockResolvedValue(true)
    start.mockResolvedValue({ state: 'running', total: 0, completed: 0 })
    refetch.mockResolvedValue(undefined)
    invalidateQueries.mockResolvedValue(undefined)
    job = {
      state: 'idle',
      total: 0,
      completed: 0,
      failed: [],
      mediaDropped: 0,
      tracks: 0,
      events: 0,
      error: null,
      finishedAtMs: null,
    }
  })

  it('renders the reconcile action on the management surface', () => {
    render(<DiskReconcileSection />)
    expect(screen.getByRole('button', { name: 'Reconcile from disk' })).toBeInTheDocument()
  })

  it('starts the hub job once after confirm', async () => {
    render(<DiskReconcileSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile from disk' }))
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1)
    })
    expect(start).toHaveBeenCalledWith()
    expect(refetch).toHaveBeenCalled()
  })

  it('does not start when the operator cancels', async () => {
    confirm.mockResolvedValue(false)
    render(<DiskReconcileSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile from disk' }))
    await waitFor(() => {
      expect(confirm).toHaveBeenCalled()
    })
    expect(start).not.toHaveBeenCalled()
  })

  it('shows fleet progress from the polled job snapshot', () => {
    job = {
      ...job,
      state: 'running',
      total: 30,
      completed: 12,
    }
    render(<DiskReconcileSection />)
    expect(screen.getByRole('button', { name: 'Reconciling 12/30…' })).toBeDisabled()
  })
})
