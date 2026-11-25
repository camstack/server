// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * The export dialog's source list and download: an unknown reach is said so
 * (never 0 days), the injected fetch gets the URL built from the picked
 * source, and a failed source read or download shows an error.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LogExportDialog } from '../log-export-dialog'

expect.extend(jestDomMatchers)

interface SourceRow {
  readonly addonId: string
  readonly readable: boolean
  readonly retentionDays: number | null
  readonly reason?: string
}

const state = vi.hoisted(() => ({
  isError: false,
  data: undefined as readonly unknown[] | undefined,
}))

vi.mock('../../trpc-react', () => ({
  trpc: {
    logs: {
      sources: { useQuery: () => ({ isError: state.isError, data: state.data }) },
    },
  },
}))
vi.mock('../../generated/system-hooks', () => ({
  useAddonsList: () => ({ data: [] }),
}))
vi.mock('../device-value-picker/DeviceValuePicker', () => ({
  DeviceValuePicker: () => null,
}))

const sources: readonly SourceRow[] = [
  { addonId: 'winston-logging', readable: true, retentionDays: 14 },
  { addonId: 'loki-logging', readable: true, retentionDays: null },
]
const initial = { components: [], deviceIds: [], source: 'loki-logging' }

describe('LogExportDialog', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
      this.open = true
    }
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
      this.open = false
    }
    state.isError = false
    state.data = sources
  })

  it('says "Reach unknown" for a null retention, never 0 days', () => {
    render(<LogExportDialog initial={initial} onClose={vi.fn()} />)
    expect(screen.getByText('Reach unknown')).toBeInTheDocument()
    expect(screen.getByText('Back 14 days')).toBeInTheDocument()
    expect(screen.queryByText(/Back 0/)).toBeNull()
  })

  it('downloads through the injected fetch with the picked source in the URL', async () => {
    const fetchBlob = vi.fn(async () => new Blob(['x']))
    render(<LogExportDialog initial={initial} onClose={vi.fn()} fetchBlob={fetchBlob} />)
    fireEvent.click(screen.getByText('Download'))
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(1))
    const calls: unknown[][] = fetchBlob.mock.calls
    expect(String(calls[0]?.[0])).toContain('/api/logs/export')
    expect(String(calls[0]?.[0])).toContain('source=loki-logging')
  })

  it('exports everything with no filter, and as a ZIP only when the box is ticked', async () => {
    const fetchBlob = vi.fn(async () => new Blob(['x']))
    render(
      <LogExportDialog
        initial={{ components: [], deviceIds: [], source: undefined }}
        onClose={vi.fn()}
        fetchBlob={fetchBlob}
      />,
    )
    fireEvent.click(screen.getByText('Download'))
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(1))
    const calls: unknown[][] = fetchBlob.mock.calls
    expect(String(calls[0]?.[0])).not.toContain('zip=')
    expect(String(calls[0]?.[0])).not.toContain('components=')
    fireEvent.click(screen.getByTestId('log-export-zip'))
    fireEvent.click(screen.getByText('Download'))
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(2))
    expect(String(calls[1]?.[0])).toContain('zip=1')
  })

  it('shows an error box when the sources could not be read, and says what happens', () => {
    state.isError = true
    state.data = undefined
    render(<LogExportDialog initial={initial} onClose={vi.fn()} />)
    expect(screen.getByText('The log sources could not be read')).toBeInTheDocument()
    expect(screen.getByText('The export falls back to the default log source.')).toBeInTheDocument()
    expect(screen.queryByText('Reading the log sources…')).toBeNull()
  })

  it('shows the failure when the download itself throws', async () => {
    const fetchBlob = vi.fn(async () => {
      throw new Error('boom')
    })
    render(<LogExportDialog initial={initial} onClose={vi.fn()} fetchBlob={fetchBlob} />)
    fireEvent.click(screen.getByText('Download'))
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })
})
