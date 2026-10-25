// @vitest-environment jsdom
/**
 * Orphan history series on the History page (D917):
 * - the notice is drawn only from an ANSWERED list with at least one series
 *   (pending draws nothing, a failed read says it could not check — D315);
 * - a selection is deleted in batches of at most 50;
 * - every row's outcome is shown, a refusal included ("no longer orphan").
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DeviceHistoryOrphanDeleteEntry,
  DeviceHistoryOrphanList,
  DeviceHistoryOrphanSeries,
} from '@camstack/types'

interface ListState {
  status: 'pending' | 'error' | 'success'
  data?: DeviceHistoryOrphanList
  error?: Error
}

let listState: ListState = { status: 'pending' }
const refetch = vi.fn()
const deleteMutate = vi.fn()
const confirmSpy = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    ...actual,
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    DialogBody: Pass,
    DialogFooter: Pass,
    useConfirm: () => async (opts: unknown) => {
      confirmSpy(opts)
      return true
    },
    useDeviceHistoryListOrphanSeries: () => ({ ...listState, refetch, isFetching: false }),
    useDeviceHistoryDeleteOrphanSeries: () => ({ mutateAsync: deleteMutate }),
    useDeviceManagerListAll: () => ({ data: [{ id: 7, name: 'Hall vacuum' }] }),
  }
})

import { OrphanSeriesNotice } from '../OrphanSeriesNotice'
import { chunkIds, deleteOrphansInBatches } from '../orphan-series-model'

const series = (
  seriesId: number,
  over: Partial<DeviceHistoryOrphanSeries> = {},
): DeviceHistoryOrphanSeries => ({
  seriesId,
  deviceId: 7,
  key: `cap:vacuum-control.tank${String(seriesId)}.level`,
  scope: '',
  displayName: `Tank ${String(seriesId)}`,
  reason: 'undeclared',
  missingSince: null,
  firstTs: Date.UTC(2026, 8, 1),
  lastTs: Date.UTC(2026, 9, 1),
  rows: { raw: 10, '5m': 2, '1h': 1, '1d': 0 },
  ...over,
})

beforeEach(() => {
  listState = { status: 'pending' }
  refetch.mockReset()
  deleteMutate.mockReset()
  confirmSpy.mockReset()
})

describe('deleteOrphansInBatches', () => {
  it('sends at most 50 ids per call, in order', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => i + 1)
    const call = vi.fn(async (batch: readonly number[]) => ({
      results: batch.map(
        (seriesId): DeviceHistoryOrphanDeleteEntry => ({
          seriesId,
          ok: true,
          deleted: { raw: 1, '5m': 0, '1h': 0, '1d': 0 },
        }),
      ),
    }))
    const out = await deleteOrphansInBatches(ids, call)
    expect(call.mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20])
    expect(call.mock.calls[2]?.[0][0]).toBe(101)
    expect(out).toHaveLength(120)
    expect(chunkIds([1, 2, 3], 50)).toEqual([[1, 2, 3]])
  })

  it('reports an id the hub did not answer as not-found, and a failed batch per id', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)
    const call = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockRejectedValueOnce(new Error('hub unreachable'))
    const out = await deleteOrphansInBatches(ids, call)
    expect(out[0]).toEqual({ seriesId: 1, ok: false, reason: 'not-found' })
    expect(out[50]).toEqual({
      seriesId: 51,
      ok: false,
      reason: 'request-failed',
      message: 'hub unreachable',
    })
  })
})

describe('OrphanSeriesNotice', () => {
  it('draws nothing while the list is unanswered', () => {
    const { container } = render(<OrphanSeriesNotice enabled />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws nothing when the answer holds no series', () => {
    listState = { status: 'success', data: { series: [], truncated: false } }
    const { container } = render(<OrphanSeriesNotice enabled />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says it could not check when the read failed, never "none"', () => {
    listState = { status: 'error', error: new Error('boom') }
    render(<OrphanSeriesNotice enabled />)
    expect(screen.getByText('Could not check for unlinked series')).toBeInTheDocument()
    expect(screen.queryByText(/no longer linked/)).toBeNull()
  })

  it('flags an answered list with series and opens the review', () => {
    listState = {
      status: 'success',
      data: {
        series: [series(1), series(2, { deviceId: 99, reason: 'device-gone', missingSince: 1 })],
        truncated: false,
      },
    }
    render(<OrphanSeriesNotice enabled />)
    expect(screen.getByText('2 series are no longer linked to a device.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Hall vacuum')).toBeInTheDocument()
    expect(within(dialog).getByText('#99 (removed)')).toBeInTheDocument()
  })

  it('shows each row outcome after deleting, a refusal included', async () => {
    listState = { status: 'success', data: { series: [series(1), series(2)], truncated: false } }
    deleteMutate.mockResolvedValue({
      results: [
        { seriesId: 1, ok: true, deleted: { raw: 10, '5m': 2, '1h': 1, '1d': 0 } },
        { seriesId: 2, ok: false, reason: 'not-orphan' },
      ],
    })
    render(<OrphanSeriesNotice enabled />)
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select every listed series' }))
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Delete selected/ }))
    })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(deleteMutate).toHaveBeenCalledWith({ seriesIds: [1, 2] })
    const outcomes = screen.getByTestId('orphan-outcomes')
    expect(within(outcomes).getByText('Deleted · 13 points')).toBeInTheDocument()
    expect(within(outcomes).getByText('Kept: no longer orphan')).toBeInTheDocument()
    expect(refetch).toHaveBeenCalled()
  })

  it('says more exist when the list is truncated and offers to load again', () => {
    listState = { status: 'success', data: { series: [series(1)], truncated: true } }
    render(<OrphanSeriesNotice enabled />)
    expect(
      screen.getByText('More than 1 series are no longer linked to a device.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(within(screen.getByTestId('orphan-truncated')).getByRole('button'))
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
