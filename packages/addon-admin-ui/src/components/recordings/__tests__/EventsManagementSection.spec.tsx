/**
 * EventsManagementSection — leftover-camera rows and delete feedback.
 *
 * Footprint lists deviceIds that are no longer cameras as `#id` with no
 * success/error after Delete. The operator cannot tell a no-op (media-only
 * #0) from a hung mutation.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.fn()
const invalidateQueries = vi.fn()
const deleteMutate = vi.fn()
const pruneMutate = vi.fn()

let footprint:
  | {
      totalRows: number
      totalBytes: number
      devices: { deviceId: number; rows: number; bytes: number }[]
    }
  | undefined
let cameras: { id: number; name: string }[]
let deletePending = false
let deleteError: Error | null = null

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}))

vi.mock('@camstack/ui-library', () => ({
  useConfirm: () => confirm,
  useDeviceManagerListAll: () => ({ data: cameras }),
  usePipelineAnalyticsGetEventStoreFootprint: () => ({
    data: footprint,
    isLoading: footprint === undefined,
  }),
  usePipelineAnalyticsPruneEvents: () => ({ mutate: pruneMutate, isPending: false }),
  usePipelineAnalyticsDeleteDeviceEvents: (opts?: {
    onSuccess?: () => void
    onError?: (err: Error) => void
  }) => ({
    mutate: (input: { deviceId: number }) => {
      deleteMutate(input)
      if (deleteError) opts?.onError?.(deleteError)
      else opts?.onSuccess?.()
    },
    mutateAsync: async (input: { deviceId: number }) => {
      deleteMutate(input)
      if (deleteError) throw deleteError
      return { motion: input.deviceId === 0 ? 0 : 12, object: 0, audio: 0 }
    },
    isPending: deletePending,
    isError: deleteError !== null,
    error: deleteError,
  }),
  DataTable: ({
    rows,
    columns,
  }: {
    rows: { deviceId: number; rows: number; bytes: number }[]
    columns: {
      key: string
      render: (r: { deviceId: number; rows: number; bytes: number }) => unknown
    }[]
  }) => (
    <table>
      <tbody>
        {rows.map((row) => (
          <tr key={row.deviceId}>
            {columns.map((col) => (
              <td key={col.key}>{col.render(row) as never}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  WidgetMetricCard: ({ children, label }: { children: unknown; label: string }) => (
    <div>
      {label}:{String(children)}
    </div>
  ),
}))

import { EventsManagementSection } from '../EventsManagementSection'

describe('EventsManagementSection leftover cameras', () => {
  beforeEach(() => {
    confirm.mockReset()
    invalidateQueries.mockReset()
    deleteMutate.mockReset()
    pruneMutate.mockReset()
    confirm.mockResolvedValue(true)
    deletePending = false
    deleteError = null
    cameras = [{ id: 104, name: 'Hall' }]
    footprint = {
      totalRows: 100,
      totalBytes: 50_000_000,
      devices: [
        { deviceId: 104, rows: 80, bytes: 40_000_000 },
        { deviceId: 3217, rows: 312, bytes: 0 },
        { deviceId: 0, rows: 0, bytes: 49_673_748 },
      ],
    }
  })

  it('names a missing camera as Removed camera #id, not a bare hash', () => {
    render(<EventsManagementSection />)
    expect(screen.getByText('Hall')).toBeInTheDocument()
    expect(screen.getByText('Removed camera #3217')).toBeInTheDocument()
    expect(screen.getByText('Removed camera #0')).toBeInTheDocument()
    expect(screen.queryByText('#3217')).not.toBeInTheDocument()
  })

  it('shows how many events Delete removed', async () => {
    render(<EventsManagementSection />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!)
    await waitFor(() => {
      expect(screen.getByText(/deleted 12 events/i)).toBeInTheDocument()
    })
  })

  it('says so when Delete removes nothing and media remains', async () => {
    render(<EventsManagementSection />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[2]!)
    await waitFor(() => {
      expect(screen.getByText(/0 events deleted/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/media still listed/i)).toBeInTheDocument()
  })

  it('surfaces a Delete failure instead of staying silent', async () => {
    deleteError = new Error('provider unavailable')
    render(<EventsManagementSection />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!)
    await waitFor(() => {
      expect(screen.getByText(/provider unavailable/i)).toBeInTheDocument()
    })
  })
})
