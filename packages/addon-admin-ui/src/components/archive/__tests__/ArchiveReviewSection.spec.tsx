/// <reference types="@testing-library/jest-dom" />
/**
 * Archive → Cameras → Review: the sources come from `videoclips.listSources`
 * (none is named by the page), the recorder plays by default, and a click on
 * an event drives the player — a seek on the recorder timeline, or the clip
 * of the picked source that holds that instant.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { selectOption, selectOptionLabels } from '@dominevo/ui-library/testing'
import type { Clip, ClipSource } from '@dominevo/types'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { EventsListReport } from '../../detection-intelligence/EventsSection'
import type { KeyEventRow } from '../../detection-intelligence/key-events-merge'
import { afterEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const EVENT_AT = 1_789_900_000_000
const OK = { state: 'ok' } as const
const RECORDER = 'recorder'

const SOURCES: readonly ClipSource[] = [
  { source: 'onboard', label: 'Camera card', addonId: 'provider-onboard', availability: OK },
  { source: 'recorder', label: 'Recorder', addonId: RECORDER, availability: OK },
  { source: 'secure', label: 'Secure video', addonId: 'provider-secure', availability: OK },
]

const ONBOARD_CLIP: Clip = {
  id: 'onboard-1',
  source: 'onboard',
  kind: 'native',
  timeRange: { startMs: EVENT_AT - 5_000, endMs: EVENT_AT + 25_000 },
}

interface SourcesAnswer {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: readonly ClipSource[]
  readonly error?: { readonly message: string } | null
}
interface ListTracksInput {
  readonly deviceId: number
  readonly limit?: number
}
interface TrackFactsRow {
  readonly trackId: string
  readonly zoneNames?: readonly string[]
}

function feedRow(trackId: string): KeyEventRow {
  return {
    id: trackId,
    trackId,
    deviceId: 101,
    timestamp: EVENT_AT,
    className: 'person',
    importance: 0.5,
    bestEventId: '',
  }
}

interface ReviewMockState {
  sources: SourcesAnswer | null
  tracks: TrackFactsRow[]
  tracksError: string | null
  feed: KeyEventRow[]
  listTracksInputs: ListTracksInput[]
}

const state = vi.hoisted(
  (): ReviewMockState => ({
    sources: null,
    tracks: [],
    tracksError: null,
    feed: [],
    listTracksInputs: [],
  }),
)

interface SeekProp {
  readonly atMs: number
  readonly nonce: number
}
interface TimelineMockProps {
  readonly seekTo?: SeekProp
  readonly lanes?: ReactNode
  readonly toolbar?: ReactNode
  readonly onExportRange?: (fromMs: number, toMs: number) => void
}
interface ExportModalProps {
  readonly onCreated: () => void
  readonly initialDeviceId?: number
  readonly initialRange?: { readonly fromMs: number; readonly toMs: number }
}
interface EventsMockProps {
  readonly onSeek?: (atMs: number) => void
  readonly onListChange?: (report: EventsListReport) => void
  readonly rowFilter?: (row: KeyEventRow) => boolean
}
interface LanesMockProps {
  readonly options: readonly { readonly value: string }[]
  readonly selectedProvider: string | null
}
interface PassProps {
  readonly children?: ReactNode
}

vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  const Pass = ({ children }: PassProps) => <>{children}</>
  return {
    ...actual,
    DeviceContextProvider: Pass,
    VodPlaybackProvider: Pass,
    RecordedPlaybackProvider: Pass,
    PlayerOverlaysProvider: Pass,
    ZoneEditingProvider: Pass,
    useVideoclipsListSources: () => state.sources ?? { status: 'success', data: SOURCES },
    usePipelineAnalyticsListTracks: (input: ListTracksInput) => {
      state.listTracksInputs.push(input)
      return state.tracksError === null
        ? { status: 'success', data: state.tracks, error: null }
        : { status: 'error', data: undefined, error: { message: state.tracksError } }
    },
    useClipLaneClips: (_deviceId: number, provider: string | null) => ({
      status: 'success',
      clips: provider === 'provider-onboard' ? [ONBOARD_CLIP] : [],
      error: null,
    }),
    RecordingTimeline: ({ seekTo, lanes, toolbar, onExportRange }: TimelineMockProps) => (
      <div data-testid="timeline">
        {toolbar}
        <button type="button" onClick={() => onExportRange?.(EVENT_AT, EVENT_AT + 60_000)}>
          shift-drag
        </button>
        <span data-testid="timeline-seek">{seekTo === undefined ? '' : String(seekTo.atMs)}</span>
        {lanes}
      </div>
    ),
    ClipSourceLanes: ({ options, selectedProvider }: LanesMockProps) => (
      <div data-testid="lanes" data-selected={selectedProvider ?? ''}>
        {options.map((o) => (
          <div key={o.value} data-testid={`lane-${o.value}`} />
        ))}
      </div>
    ),
    ClipPanel: ({ clip }: { readonly clip: Clip }) => <div data-testid="clip-panel">{clip.id}</div>,
  }
})

function EventsMock({ onSeek, onListChange, rowFilter }: EventsMockProps) {
  const kept = state.feed.filter((row) => rowFilter === undefined || rowFilter(row))
  const keptIds = kept.map((row) => row.trackId).join(',')
  useEffect(() => {
    onListChange?.({ rows: kept, narrowed: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptIds, onListChange])
  return (
    <>
      <span data-testid="events-kept">{keptIds}</span>
      <button type="button" onClick={() => onSeek?.(EVENT_AT)}>
        event at
      </button>
    </>
  )
}
vi.mock('../../detection-intelligence/EventsSection', () => ({ EventsSection: EventsMock }))
vi.mock('../../device/PanelContent', () => ({
  StreamPanelContent: () => <div data-testid="player" />,
}))
vi.mock('../../recordings/NewExportModal', () => ({
  NewExportModal: ({ initialDeviceId, initialRange, onCreated }: ExportModalProps) => (
    <div data-testid="export-modal">
      {String(initialDeviceId)}:{String(initialRange?.fromMs)}-{String(initialRange?.toMs)}
      <button type="button" onClick={onCreated}>
        create export
      </button>
    </div>
  ),
}))
vi.mock('../ReviewEventTools', () => ({ ReviewEventTools: () => null }))

const { ArchiveReviewSection } = await import('../ArchiveReviewSection')

afterEach(() => {
  state.sources = null
  state.tracks = []
  state.tracksError = null
  state.feed = []
  state.listTracksInputs = []
})

describe('ArchiveReviewSection', () => {
  it('lists every source the camera returned, one lane each, recorder selected by default', () => {
    render(<ArchiveReviewSection deviceId={101} />)
    const picker = screen.getByRole('combobox', { name: 'Source' })
    expect(picker).toHaveValue(RECORDER)
    expect(selectOptionLabels(picker)).toEqual(['Camera card', 'Recorder', 'Secure video'])
    expect(screen.getByTestId('lane-provider-onboard')).toBeInTheDocument()
    expect(screen.getByTestId(`lane-${RECORDER}`)).toBeInTheDocument()
    expect(screen.getByTestId('lane-provider-secure')).toBeInTheDocument()
    expect(screen.getByTestId('lanes')).toHaveAttribute('data-selected', RECORDER)
  })

  it('an event click seeks the recorder timeline to that instant', () => {
    render(<ArchiveReviewSection deviceId={101} />)
    expect(screen.getByTestId('timeline-seek')).toHaveTextContent('')
    fireEvent.click(screen.getByRole('button', { name: 'event at' }))
    expect(screen.getByTestId('timeline-seek')).toHaveTextContent(String(EVENT_AT))
    expect(screen.queryByTestId('clip-panel')).not.toBeInTheDocument()
  })

  it('with another source picked, an event click plays that source’s clip at the instant', () => {
    render(<ArchiveReviewSection deviceId={101} />)
    selectOption(screen.getByRole('combobox', { name: 'Source' }), 'provider-onboard')
    fireEvent.click(screen.getByRole('button', { name: 'event at' }))
    expect(screen.getByTestId('clip-panel')).toHaveTextContent('onboard-1')
    expect(screen.getByTestId('timeline-seek')).toHaveTextContent('')
  })

  it('says so when the picked source holds nothing at that instant', () => {
    render(<ArchiveReviewSection deviceId={101} />)
    selectOption(screen.getByRole('combobox', { name: 'Source' }), 'provider-secure')
    fireEvent.click(screen.getByRole('button', { name: 'event at' }))
    expect(screen.queryByTestId('clip-panel')).not.toBeInTheDocument()
    expect(screen.getByText(/holds no clip at/)).toBeInTheDocument()
  })

  it('asks for as many tracks as the event feed holds per camera, not the store default', () => {
    render(<ArchiveReviewSection deviceId={101} />)
    expect(state.listTracksInputs.at(-1)?.limit).toBe(200)
  })

  it('a zone filter keeps rows whose track did not load and says how many it did not check', () => {
    state.tracks = Array.from({ length: 120 }, (_, i) => ({
      trackId: `t${String(i)}`,
      zoneNames: i === 0 ? ['Driveway'] : ['Yard'],
    }))
    state.feed = [feedRow('t0'), feedRow('t1'), feedRow('lost')]
    render(<ArchiveReviewSection deviceId={101} />)
    selectOption(screen.getByRole('combobox', { name: 'Zone' }), 'Driveway')
    expect(screen.getByTestId('events-kept')).toHaveTextContent('t0,lost')
    expect(screen.getByTestId('archive-review-unchecked')).toHaveTextContent(
      'Events not checked by this filter: 1',
    )
  })

  it('sources still loading are said so, not drawn as no sources', () => {
    state.sources = { status: 'pending' }
    render(<ArchiveReviewSection deviceId={101} />)
    expect(screen.getByText('Loading sources…')).toBeInTheDocument()
  })

  it('a failed sources read says why', () => {
    state.sources = { status: 'error', error: { message: 'provider offline' } }
    render(<ArchiveReviewSection deviceId={101} />)
    expect(screen.getByRole('alert')).toHaveTextContent('provider offline')
  })

  it('a failed track read says why, so the zone and face / plate filters are not read as empty', () => {
    state.tracksError = 'analytics store offline'
    render(<ArchiveReviewSection deviceId={101} />)
    expect(screen.getByTestId('archive-review-tracks-failed')).toHaveTextContent(
      'Track facts could not be read — analytics store offline',
    )
    expect(screen.getByTestId('archive-review-tracks-failed')).toHaveAttribute('role', 'alert')
  })

  it('shift-drag on the timeline opens the export dialog for this camera and range', () => {
    render(<ArchiveReviewSection deviceId={101} />)
    expect(screen.queryByTestId('export-modal')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'shift-drag' }))
    expect(screen.getByTestId('export-modal')).toHaveTextContent(
      `101:${String(EVENT_AT)}-${String(EVENT_AT + 60_000)}`,
    )
  })

  it('a created export says so and links to Library → Exports for this camera', () => {
    render(
      <MemoryRouter>
        <ArchiveReviewSection deviceId={101} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'shift-drag' }))
    fireEvent.click(screen.getByRole('button', { name: 'create export' }))
    expect(screen.queryByTestId('export-modal')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Library → Exports/ })).toHaveAttribute(
      'href',
      '/library?tab=exports&camera=101',
    )
  })
})
