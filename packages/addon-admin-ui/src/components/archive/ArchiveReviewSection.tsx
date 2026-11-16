/**
 * Archive → Cameras → Review: the player beside the events of the timeline
 * window, and the timeline below them, full width.
 *
 * - The timeline owns the window (date, zoom, pan) and reports it; the event
 *   list follows it, and the page's filters narrow the list AND the density
 *   bar through one predicate (`review-filters.ts`).
 * - Every clip source the camera lists (`videoclips.listSources`) is a lane
 *   under the coverage bar; the Source selector picks which one the player
 *   plays — the recorder by default when the camera lists it. No source is
 *   named here: the rows are whatever the bindings returned.
 * - A click on the timeline or on an event drives the player. With the
 *   recorder selected the timeline plays it; with another source the clip of
 *   that source holding the instant plays.
 * - Shift-drag on the coverage bar opens the export dialog on that range.
 *
 * The player is 16:9 and at most 40% of the viewport tall, so the timeline and
 * every source lane stay on screen at 1440×900. All filters (source, kinds,
 * score, sort, zone, subject, debug) share ONE bar, the timeline's controls
 * row, so the list and the density bar follow the same controls.
 * Phone: one column — player, timeline, events.
 */
import {
  clipAtInstant,
  ClipPanel,
  clipProviderOptions,
  ClipSourceLanes,
  defaultClipProvider,
  DeviceContextProvider,
  ErrorBox,
  PlayerOverlaysProvider,
  RecordedPlaybackProvider,
  RecordingTimeline,
  Select,
  useClipLaneClips,
  usePipelineAnalyticsListTracks,
  useVideoclipsListSources,
  VodPlaybackProvider,
  ZoneEditingProvider,
  type DayWindow,
} from '@camstack/ui-library'
import { RECORDING_SOURCE_CAMSTACK_ADDON, type CamProfile, type Clip } from '@camstack/types'
import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { EventsSection } from '../detection-intelligence/EventsSection'
import type { EventsListReport } from '../detection-intelligence/EventsSection'
import { StreamPanelContent } from '../device/PanelContent'
import { NewExportModal } from '../recordings/NewExportModal'
import {
  densityPointsOf,
  factsByTrack,
  NO_REVIEW_FILTERS,
  reviewRowFilter,
  zonesVisited,
  type ReviewFilters,
  type TrackFacts,
} from './review-filters'
import { ReviewEventTools } from './ReviewEventTools'
import { ReviewFilterBar } from './ReviewFilterBar'

export interface ArchiveReviewSectionProps {
  readonly deviceId: number
}

interface ReviewSeek {
  readonly atMs: number
  readonly nonce: number
}

interface ExportDraft {
  readonly fromMs: number
  readonly toMs: number
}

function todayWindow(): DayWindow {
  const now = Date.now()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return { fromMs: start.getTime(), toMs: now }
}

const NO_TRACKS: readonly TrackFacts[] = []

export function ArchiveReviewSection({ deviceId }: ArchiveReviewSectionProps): ReactElement {
  return (
    <DeviceContextProvider deviceId={deviceId}>
      <VodPlaybackProvider>
        <RecordedPlaybackProvider>
          <PlayerOverlaysProvider>
            <ZoneEditingProvider>
              <ReviewBody key={deviceId} deviceId={deviceId} />
            </ZoneEditingProvider>
          </PlayerOverlaysProvider>
        </RecordedPlaybackProvider>
      </VodPlaybackProvider>
    </DeviceContextProvider>
  )
}

function ReviewBody({ deviceId }: ArchiveReviewSectionProps): ReactElement {
  const { t } = useTranslation()
  const [view, setView] = useState<DayWindow>(todayWindow)
  const [filters, setFilters] = useState<ReviewFilters>(NO_REVIEW_FILTERS)
  const [report, setReport] = useState<EventsListReport | null>(null)
  const [seek, setSeek] = useState<ReviewSeek | undefined>(undefined)
  const [draft, setDraft] = useState<ExportDraft | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [activeClip, setActiveClip] = useState<Clip | null>(null)
  const [profile, setProfile] = useState<CamProfile>('high')
  const [clipMiss, setClipMiss] = useState<number | null>(null)
  // The single filter bar's slot where the event list's own filters render.
  const [eventsBar, setEventsBar] = useState<HTMLElement | null>(null)

  // Clip sources — one option per provider, in the camera's own order.
  const sources = useVideoclipsListSources({ deviceId })
  const options = useMemo(() => clipProviderOptions(sources.data ?? []), [sources.data])
  const provider = picked ?? defaultClipProvider(options, RECORDING_SOURCE_CAMSTACK_ADDON)
  const recorderPlays = provider === null || provider === RECORDING_SOURCE_CAMSTACK_ADDON
  const selectedClips = useClipLaneClips(deviceId, recorderPlays ? null : provider, view)

  // The window's tracks: where the zone and face / plate facts live.
  const tracks = usePipelineAnalyticsListTracks({
    deviceId,
    since: view.fromMs,
    until: view.toMs,
    projection: 'slim',
  })
  const trackRows: readonly TrackFacts[] = tracks.data ?? NO_TRACKS
  const zones = useMemo(() => zonesVisited(trackRows), [trackRows])
  const facts = useMemo(() => factsByTrack(trackRows), [trackRows])
  const rowFilter = useMemo(() => reviewRowFilter(filters, facts), [filters, facts])
  // The density bar follows the list only while something narrows it; the
  // unnarrowed bar is the server histogram, motion and audio included.
  const pageNarrows = filters.zone !== null || filters.identity !== 'any' || filters.debug
  const densityPoints = useMemo(
    () =>
      report !== null && (report.narrowed || pageNarrows)
        ? densityPointsOf(report.rows)
        : undefined,
    [report, pageNarrows],
  )

  const eventsWindow = useMemo(() => ({ since: view.fromMs, until: view.toMs }), [view])
  const onViewChange = useCallback((next: DayWindow) => setView(next), [])

  const playAt = useCallback(
    (atMs: number): void => {
      setClipMiss(null)
      if (recorderPlays) {
        setActiveClip(null)
        setSeek((prev) => ({ atMs, nonce: (prev?.nonce ?? 0) + 1 }))
        return
      }
      const clip = clipAtInstant(selectedClips.clips, atMs)
      if (clip === null) setClipMiss(atMs)
      setActiveClip(clip)
    },
    [recorderPlays, selectedClips.clips],
  )

  const onPickClip = useCallback((laneProvider: string, clip: Clip): void => {
    setPicked(laneProvider)
    setClipMiss(null)
    if (laneProvider === RECORDING_SOURCE_CAMSTACK_ADDON) {
      setActiveClip(null)
      setSeek((prev) => ({
        atMs: clip.timeRange.startMs,
        nonce: (prev?.nonce ?? 0) + 1,
      }))
      return
    }
    setActiveClip(clip)
  }, [])

  const sourcePicker =
    options.length > 1 ? (
      <Select
        wrapperClassName="inline-block w-auto"
        aria-label={t('archive.review.source', 'Source')}
        value={provider ?? ''}
        onChange={(e) => {
          setPicked(e.target.value)
          setActiveClip(null)
          setClipMiss(null)
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    ) : null

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,calc(40vh*16/9))_minmax(20rem,1fr)]">
      <div className="order-1 flex min-w-0 flex-col gap-2 lg:order-none lg:col-start-1 lg:row-start-1">
        <div
          className="mx-auto aspect-video w-full max-w-[calc(40vh*16/9)] overflow-hidden rounded-lg border border-border bg-black"
          data-testid="archive-review-player"
        >
          <StreamPanelContent deviceId={deviceId} />
        </div>
        {clipMiss !== null && (
          <ErrorBox
            variant="warning"
            message={t(
              'archive.review.noClipAt',
              'This source holds no clip at {{time}}. Pick another source or another moment.',
              { time: new Date(clipMiss).toLocaleTimeString() },
            )}
          />
        )}
        {activeClip !== null && provider !== null && (
          <ClipPanel
            deviceId={deviceId}
            clip={activeClip}
            profile={profile}
            onProfileChange={setProfile}
          />
        )}
      </div>

      <div
        className="order-3 flex min-w-0 flex-col gap-2 lg:order-none lg:col-start-2 lg:row-start-1 lg:max-h-[40vh] lg:overflow-y-auto"
        data-testid="archive-review-events"
      >
        <EventsSection
          deviceId={deviceId}
          window={eventsWindow}
          rowFilter={rowFilter}
          onListChange={setReport}
          onSeek={playAt}
          layout="rows"
          toolbarTarget={eventsBar}
        />
      </div>

      <div className="order-2 flex min-w-0 flex-col gap-2 lg:order-none lg:col-span-2 lg:row-start-2">
        <RecordingTimeline
          deviceId={deviceId}
          seekTo={seek}
          onExportRange={(fromMs, toMs) => setDraft({ fromMs, toMs })}
          onViewChange={onViewChange}
          densityPoints={densityPoints}
          toolbar={
            <div className="contents" data-testid="archive-review-bar">
              {sourcePicker}
              <span ref={setEventsBar} className="contents" />
              <ReviewFilterBar filters={filters} zones={zones} onChange={setFilters} />
            </div>
          }
          lanes={
            <ClipSourceLanes
              deviceId={deviceId}
              options={options}
              view={view}
              selectedProvider={provider}
              onPickClip={onPickClip}
            />
          }
        />
      </div>

      <div className="order-4 min-w-0 lg:order-none lg:col-span-2 lg:row-start-3">
        <ReviewEventTools deviceId={deviceId} debug={filters.debug} />
      </div>

      {draft !== null && (
        <NewExportModal
          onClose={() => setDraft(null)}
          onCreated={() => setDraft(null)}
          initialDeviceId={deviceId}
          initialRange={draft}
        />
      )}
    </div>
  )
}
