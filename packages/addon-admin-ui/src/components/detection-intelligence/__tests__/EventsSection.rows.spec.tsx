/// <reference types="@testing-library/jest-dom" />
/**
 * EventsSection in the Archive Review `rows` layout: a row click seeks, the
 * class chips narrow the list AND the list reported to the density bar, and
 * the size slider changes how large each row's thumbnail is.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventsListReport } from '../EventsSection'
import type { KeyEventRow } from '../key-events-merge'

expect.extend(jestDomMatchers)

const AT = 1_789_900_000_000

function eventRow(trackId: string, className: string, offsetMs: number): KeyEventRow {
  return {
    id: trackId,
    trackId,
    deviceId: 101,
    timestamp: AT + offsetMs,
    className,
    importance: 0.5,
    bestEventId: '',
  }
}

const ROWS: readonly KeyEventRow[] = [
  eventRow('t1', 'person', 0),
  eventRow('t2', 'vehicle', 60_000),
  eventRow('t3', 'person', 120_000),
]

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useAlert: () => vi.fn(),
    useConfirm: () => vi.fn(),
    useDeviceManagerListAll: () => ({ data: [{ id: 101, name: 'Front door' }] }),
    usePipelineAnalyticsListEventKindsBatch: () => ({ data: [], isLoading: false }),
  }
})
vi.mock('../use-key-events-feed', () => ({
  useKeyEventsFeed: () => ({ rows: ROWS, isLoading: false }),
}))
vi.mock('../use-events-live-refresh', () => ({
  useEventsLiveRefresh: () => ({ pending: false, refreshNow: vi.fn() }),
}))
vi.mock('../../../lib/authed-media', () => ({
  mediaIdPath: (id: number) => `/media/${String(id)}`,
  mediaOwnerPath: (kind: string, id: string) => `/media/${kind}/${id}`,
  useAuthedImage: () => ({ src: null }),
}))
vi.mock('../use-delete-tracks', () => ({
  DELETE_TRACKS_AVAILABLE: false,
  DELETE_UNAVAILABLE_TITLE: '',
  useDeleteTracksMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}))
vi.mock('../EventDetailPanel', () => ({ EventDetailPanel: () => null }))

const { EventsSection } = await import('../EventsSection')

interface Harness {
  readonly onSeek: ReturnType<typeof vi.fn>
  readonly reports: EventsListReport[]
}

function renderRows(): Harness {
  const onSeek = vi.fn()
  const reports: EventsListReport[] = []
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EventsSection
        deviceId={101}
        window={{ since: AT - 3_600_000, until: AT + 3_600_000 }}
        layout="rows"
        onSeek={onSeek}
        onListChange={(report) => reports.push(report)}
      />
    </QueryClientProvider>,
  )
  return { onSeek, reports }
}

afterEach(() => {
  window.localStorage.clear()
})

describe('EventsSection rows layout', () => {
  it('a row click seeks to that event', () => {
    const { onSeek } = renderRows()
    expect(screen.getAllByTestId('event-row')).toHaveLength(3)
    fireEvent.click(screen.getAllByRole('button', { name: /^Play vehicle at/ })[0])
    expect(onSeek).toHaveBeenCalledWith(AT + 60_000)
  })

  it('a class chip switched off narrows the list and the list the density bar draws', () => {
    const { reports } = renderRows()
    const chips = screen.getByTestId('event-class-chips')
    fireEvent.click(within(chips).getByRole('button', { name: 'person' }))
    expect(screen.getAllByTestId('event-row')).toHaveLength(1)
    const last = reports.at(-1)
    expect(last?.narrowed).toBe(true)
    expect(last?.rows.map((r) => r.className)).toEqual(['vehicle'])
  })

  it('the size slider grows the thumbnails and is remembered', () => {
    renderRows()
    const thumb = (): HTMLElement =>
      within(screen.getAllByTestId('event-row')[0]).getByRole('button', {
        name: 'Open event details',
      })
    expect(thumb()).toHaveClass('w-[72px]')
    fireEvent.change(screen.getByTestId('event-row-size'), { target: { value: '2' } })
    expect(thumb()).toHaveClass('w-40')
    expect(window.localStorage.getItem('camstack.archive.eventRowSize')).toBe('2')
  })
})
