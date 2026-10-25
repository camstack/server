/**
 * ActivitySection — the ops log renders through the app's STANDARD table, with
 * the conventions a list of manageable items is required to carry, and it
 * still shows every datum it showed before.
 *
 * Two things are pinned here and they fail for different reasons:
 *
 *  1. The table DECISION — the props this surface chooses (`maxBodyHeight`,
 *     `defaultSort`, a `sortValue` per column). Asserted on
 *     the props handed to `DataTable`, not on a class string: docs/ui/conventions.md's rule is
 *     "test the decision, not the class".
 *  2. The CONTENT — every column header and every rendered datum, plus the
 *     domain filter, plus the two states that must never be confused with one
 *     another (nothing happened vs nobody answered).
 *
 * The real `DataTable` still renders underneath the capture wrapper, so a
 * column that stops rendering fails here too.
 */

import type { OpsLogEntry } from '@camstack/types'
import type { DataTableProps } from '@camstack/ui-library'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MockState {
  rec: OpsLogEntry[]
  evt: OpsLogEntry[]
  recFailed: boolean
  evtFailed: boolean
  loading: boolean
  captured: DataTableProps<OpsLogEntry>[]
}

const state = vi.hoisted(() => {
  const s: MockState = {
    rec: [],
    evt: [],
    recFailed: false,
    evtFailed: false,
    loading: false,
    captured: [],
  }
  return s
})

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const Real = actual.DataTable
  return {
    ...actual,
    DataTable: (props: DataTableProps<OpsLogEntry>) => {
      state.captured.push(props)
      return <Real {...props} />
    },
    useRecordingArchiveListOpsLog: () => ({
      data: state.rec,
      isLoading: state.loading,
      isError: state.recFailed,
    }),
    usePipelineAnalyticsListOpsLog: () => ({
      data: state.evt,
      isLoading: state.loading,
      isError: state.evtFailed,
    }),
    useDeviceManagerListAll: () => ({
      data: [
        { id: 1, name: 'Front Gate' },
        { id: 2, name: 'Driveway' },
      ],
    }),
  }
})

import { TABLE_SCROLL_MAX_H } from '@camstack/ui-library'
import { ActivitySection } from '../ActivitySection'

function row(over: Partial<OpsLogEntry>): OpsLogEntry {
  return {
    id: 'r1',
    at: 1_700_000_000_000,
    domain: 'recording',
    op: 'prune',
    reason: 'retention',
    deviceId: 1,
    nodeId: 'hub',
    itemsAffected: 12,
    bytesReclaimed: 1024,
    detail: null,
    actor: 'operator',
    ...over,
  }
}

const RECORDING_ROW: OpsLogEntry = row({
  id: 'rec-1',
  domain: 'recording',
  op: 'prune',
  deviceId: 1,
  itemsAffected: 12,
  bytesReclaimed: 2048,
})
const EVENT_ROW: OpsLogEntry = row({
  id: 'evt-1',
  at: 1_700_000_500_000,
  domain: 'events',
  op: 'manual-delete',
  reason: 'operator',
  deviceId: 2,
  itemsAffected: 3,
  bytesReclaimed: 4096,
})

beforeEach(() => {
  state.rec = [RECORDING_ROW]
  state.evt = [EVENT_ROW]
  state.recFailed = false
  state.evtFailed = false
  state.loading = false
  state.captured = []
})

/** The props handed to the last `DataTable` render. */
function lastTable(): DataTableProps<OpsLogEntry> {
  const last = state.captured.at(-1)
  if (last === undefined) throw new Error('DataTable was never rendered')
  return last
}

describe('ActivitySection — the standard table', () => {
  it('renders through DataTable with the list conventions', () => {
    render(<ActivitySection />)
    const props = lastTable()
    expect(props.maxBodyHeight).toBe(TABLE_SCROLL_MAX_H)
  })

  it('opens newest-first and lets the operator re-sort', () => {
    render(<ActivitySection />)
    expect(lastTable().defaultSort).toEqual({ columnKey: 'at', dir: 'desc' })
  })

  it('keeps every column and makes each one sortable', () => {
    render(<ActivitySection />)
    const columns = lastTable().columns
    expect(columns.map((c) => c.key)).toEqual([
      'at',
      'domain',
      'op',
      'reason',
      'device',
      'items',
      'bytes',
    ])
    expect(columns.filter((c) => c.sortValue === undefined)).toEqual([])
  })

  it('sorts on RAW values, never the rendered ones', () => {
    render(<ActivitySection />)
    const by = new Map(lastTable().columns.map((c) => [c.key, c.sortValue]))
    // A byte count, not "2 KB" — "9 MB" sorts before "1 GB" as text.
    expect(by.get('bytes')?.(RECORDING_ROW)).toBe(2048)
    expect(by.get('at')?.(RECORDING_ROW)).toBe(1_700_000_000_000)
    expect(by.get('items')?.(RECORDING_ROW)).toBe(12)
    // The camera column orders by NAME, and a cluster row is a value, not a gap.
    expect(by.get('device')?.(RECORDING_ROW)).toBe('Front Gate')
    expect(by.get('device')?.(row({ deviceId: null }))).toBe('cluster')
  })
})

describe('ActivitySection — content', () => {
  it('shows every header it showed before', () => {
    render(<ActivitySection />)
    for (const header of ['When', 'Domain', 'Operation', 'Reason', 'Camera', 'Items', 'Reclaimed'])
      expect(screen.getByText(header)).toBeInTheDocument()
  })

  it('shows both domains merged, with each row keeping its data', () => {
    render(<ActivitySection />)
    const table = screen.getByRole('table')
    expect(within(table).getByText('prune')).toBeInTheDocument()
    expect(within(table).getByText('manual-delete')).toBeInTheDocument()
    expect(within(table).getByText('Front Gate')).toBeInTheDocument()
    expect(within(table).getByText('Driveway')).toBeInTheDocument()
    expect(within(table).getByText('12')).toBeInTheDocument()
    expect(within(table).getByText('2.0 KB')).toBeInTheDocument()
  })

  it('keeps the domain filter — the only way to read one domain without a second table', () => {
    render(<ActivitySection />)
    fireEvent.click(screen.getByRole('button', { name: 'Events' }))
    const table = screen.getByRole('table')
    expect(within(table).getByText('manual-delete')).toBeInTheDocument()
    expect(within(table).queryByText('prune')).not.toBeInTheDocument()
  })
})

describe('ActivitySection — empty is not broken', () => {
  it('an empty log reads as "nothing happened"', () => {
    state.rec = []
    state.evt = []
    render(<ActivitySection />)
    expect(screen.getByText('No activity yet')).toBeInTheDocument()
  })

  it('a log nobody answered does NOT read as empty', () => {
    state.rec = []
    state.evt = []
    state.recFailed = true
    state.evtFailed = true
    render(<ActivitySection />)
    expect(screen.getByText('Activity could not be read')).toBeInTheDocument()
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument()
  })

  it('names the domain that failed when the other one still has rows', () => {
    state.evt = []
    state.evtFailed = true
    render(<ActivitySection />)
    expect(screen.getByText(/Events did not answer/)).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('does not warn about a domain the filter excluded', () => {
    state.evt = []
    state.evtFailed = true
    render(<ActivitySection />)
    fireEvent.click(screen.getByRole('button', { name: 'Recordings' }))
    expect(screen.queryByText(/did not answer/)).not.toBeInTheDocument()
  })
})
