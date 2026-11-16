/// <reference types="@testing-library/jest-dom" />
/**
 * Archive → Cameras → Review: the sources come from `videoclips.listSources`
 * (none is named by the page), the recorder plays by default, and a click on
 * an event drives the player — a seek on the recorder timeline, or the clip
 * of the picked source that holds that instant.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { selectOption, selectOptionLabels } from '@camstack/ui-library/testing'
import type { Clip, ClipSource } from '@camstack/types'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

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

interface SeekProp {
  readonly atMs: number
  readonly nonce: number
}
interface TimelineMockProps {
  readonly seekTo?: SeekProp
  readonly lanes?: ReactNode
  readonly toolbar?: ReactNode
}
interface LanesMockProps {
  readonly options: readonly { readonly value: string }[]
  readonly selectedProvider: string | null
}
interface PassProps {
  readonly children?: ReactNode
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const Pass = ({ children }: PassProps) => <>{children}</>
  return {
    ...actual,
    DeviceContextProvider: Pass,
    VodPlaybackProvider: Pass,
    RecordedPlaybackProvider: Pass,
    PlayerOverlaysProvider: Pass,
    ZoneEditingProvider: Pass,
    useVideoclipsListSources: () => ({ data: SOURCES }),
    usePipelineAnalyticsListTracks: () => ({ data: [] }),
    useClipLaneClips: (_deviceId: number, provider: string | null) => ({
      status: 'success',
      clips: provider === 'provider-onboard' ? [ONBOARD_CLIP] : [],
      error: null,
    }),
    RecordingTimeline: ({ seekTo, lanes, toolbar }: TimelineMockProps) => (
      <div data-testid="timeline">
        {toolbar}
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

vi.mock('../../detection-intelligence/EventsSection', () => ({
  EventsSection: ({ onSeek }: { readonly onSeek?: (atMs: number) => void }) => (
    <button type="button" onClick={() => onSeek?.(EVENT_AT)}>
      event at
    </button>
  ),
}))
vi.mock('../../device/PanelContent', () => ({
  StreamPanelContent: () => <div data-testid="player" />,
}))
vi.mock('../../recordings/NewExportModal', () => ({ NewExportModal: () => null }))
vi.mock('../ReviewEventTools', () => ({ ReviewEventTools: () => null }))
vi.mock('../ReviewFilterBar', () => ({ ReviewFilterBar: () => null }))

const { ArchiveReviewSection } = await import('../ArchiveReviewSection')

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
})
