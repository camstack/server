import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { RECORDING_SOURCE_CAMSTACK_ADDON } from '@camstack/types'
import { Film, Pause, Play, Radio } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent, type JSX } from 'react'
import { useRecordedPlayback } from '../../contexts/recorded-playback'
import { useSystem } from '../../contexts/system-context'
import { useVodPlayback } from '../../contexts/vod-playback'
import {
  usePipelineAnalyticsGetAudioEvents,
  usePipelineAnalyticsGetEventDensity,
  usePipelineAnalyticsGetMotionEvents,
  usePipelineAnalyticsGetObjectEvents,
  useRecordingGetAvailability,
} from '../../generated/system-hooks'
import type { RecordedPlaybackMode } from '../../lib/recorded-control-protocol'
import { type PlaybackControlSink, useScrubController } from '../../lib/scrub-controller'
import { EmptyState } from '../empty-state'
import { SendFrameToTrainingButton } from '../training/send-frame-to-training'
import { ErrorBox } from '../error-box'
import { CoverageTrack } from './CoverageTrack'
import { type BucketClip, EventBucketStrip } from './EventBucketStrip'
import { EventHeatmap } from './EventHeatmap'
import type { ClipKind } from './event-thumb'
import { type AvailabilityRange, mergeAvailabilitySpans } from './recording-spans'
import {
  axisTicks,
  bucketMsForSpan,
  type DayWindow,
  dayWindow,
  densityRowsToBuckets,
  panWindow,
  seekTargetForSpans,
} from './recording-timeline-model'
import { TimelineControls } from './TimelineControls'

// All recognized event kinds in canonical order.
const ALL_KINDS: readonly ClipKind[] = ['motion', 'object', 'audio']

// Initial and incremental page size for the drill-down event queries.
const INITIAL_PAGE = 60
// How many ms one pixel of horizontal delta maps to when panning via wheel.
// Calibrated so a standard wheel tick (~100 px of deltaX) pans ~30 min.
const PAN_MS_PER_PX = 18_000 / 100
// Per-event playback padding around a point event.
const EVENT_PRE_MS = 5_000
const EVENT_POST_MS = 10_000
const EMPTY_RANGES: readonly AvailabilityRange[] = []

// Human labels for the frame-push playback mode chip.
function modeLabel(t: UiTextFn, mode: RecordedPlaybackMode): string {
  switch (mode) {
    case 'live':
      return t('uiLibrary.recordingTimeline.modeLive', 'Live')
    case 'loading':
      return t('uiLibrary.recordingTimeline.modeLoading', 'Loading…')
    case 'playing':
      return t('uiLibrary.recordingTimeline.modePlaying', 'Playing')
    case 'paused':
      return t('uiLibrary.recordingTimeline.modePaused', 'Paused')
    case 'gap':
      return t('uiLibrary.recordingTimeline.modeGap', 'No footage')
    case 'ended':
      return t('uiLibrary.recordingTimeline.modeEnded', 'Ended')
    case 'error':
      return t('uiLibrary.recordingTimeline.modeError', 'Error')
  }
}

interface RecordingTimelineProps {
  readonly deviceId: number
}

// Continuous navigable timeline: date picker, a click-to-seek coverage track,
// and a motion/object/audio event-density heatmap. Selecting a heatmap bucket
// reveals that window's events as a thumbnail strip.
//
// Playback (R9 — two planes):
// - FRAME-PUSH (default when available): when the hero player's
//   `camstack-control` datachannel is open (RecordedPlaybackProvider +
//   StreamPanel on the same page), coverage clicks/drags and event clicks
//   drive the broker's `TimelineSession`/`RecordedFeeder` directly — recorded
//   frames arrive on the SAME live WebRTC `<video>`, with drag-scrub
//   (throttled), commit-on-release, a ~1 Hz playhead, pause/resume, and a
//   Go-Live return. This mirrors the shipped viewer's default recorded path.
// - HLS VOD (fallback/option): resolve a playback manifest and drive the hero
//   VOD context — used when no control channel exists (player stopped,
//   server-offer mode, no provider) or when the operator forces it.
export function RecordingTimeline({ deviceId }: RecordingTimelineProps): JSX.Element {
  const t = useUiText()
  const system = useSystem()
  const vod = useVodPlayback()
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null)
  const [playheadMs, setPlayheadMs] = useState<number | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)

  // ── R9: frame-push recorded playback over the camstack-control channel ────
  const recorded = useRecordedPlayback()
  const { send: sendControl, mode: recordedMode, positionMs: recordedPositionMs } = recorded
  // Operator override: force the legacy HLS VOD path even when the control
  // channel is available (kept as an explicit fallback/option).
  const [forceHls, setForceHls] = useState(false)
  const framePush = recorded.channelOpen && !forceHls
  const framePushRef = useRef(framePush)
  framePushRef.current = framePush

  // Sink over the datachannel. `scrubStart`/`scrubTo` are client-side only —
  // the wire protocol has no per-move scrub message (the server only ever
  // sees the committed target); they remain the hook-point for a future
  // WebCodecs drag preview (R8).
  const sink = useMemo<PlaybackControlSink>(
    () => ({
      scrubStart: () => {},
      scrubTo: () => {},
      scrubCommit: (epochMs: number) => {
        sendControl({ t: 'scrubCommit', epoch: epochMs })
      },
      seek: (epochMs: number) => {
        sendControl({ t: 'seek', epoch: epochMs })
      },
    }),
    [sendControl],
  )
  const recordedModeRef = useRef(recordedMode)
  recordedModeRef.current = recordedMode
  const isPlayerLive = useCallback((): boolean => recordedModeRef.current === 'live', [])
  const {
    state: scrubState,
    beginScrub,
    updateScrub,
    endScrub,
    seek: scrubSeek,
    setPlayhead,
    reset: resetScrub,
  } = useScrubController(sink, isPlayerLive)

  // Feed the server's ~1 Hz position reports into the scrub controller (the
  // reducer ignores them mid-drag so the drag target wins).
  useEffect(() => {
    if (recordedPositionMs !== null) setPlayhead(recordedPositionMs)
  }, [recordedPositionMs, setPlayhead])

  // Back to live (goLive ack / channel drop) → clear the scrub position.
  useEffect(() => {
    if (!recorded.channelOpen || recordedMode === 'live') resetScrub()
  }, [recorded.channelOpen, recordedMode, resetScrub])

  const handleGoLive = useCallback((): void => {
    sendControl({ t: 'goLive' })
    resetScrub()
  }, [sendControl, resetScrub])

  const handleRateToggle = useCallback((): void => {
    sendControl({ t: 'setRate', rate: recordedModeRef.current === 'paused' ? 1 : 0 })
  }, [sendControl])

  // D5: type filter — which event kinds to display and query.
  const [enabledKinds, setEnabledKinds] = useState<ReadonlySet<ClipKind>>(() => new Set(ALL_KINDS))
  const toggleKind = useCallback((kind: ClipKind): void => {
    setEnabledKinds((current) => {
      const next = new Set(current)
      if (next.has(kind)) {
        next.delete(kind)
      } else {
        next.add(kind)
      }
      return next
    })
  }, [])

  // D5: pagination — page limit resets when the selected bucket changes.
  const [pageLimit, setPageLimit] = useState(INITIAL_PAGE)
  const handleLoadMore = useCallback((): void => {
    setPageLimit((n) => n + INITIAL_PAGE)
  }, [])

  // D5: reset pagination whenever the selected bucket changes.
  useEffect(() => {
    setPageLimit(INITIAL_PAGE)
  }, [selectedBucket])

  // D2: view state — navigable day window
  const [day, setDay] = useState<Date>(() => new Date())
  const [view, setView] = useState<DayWindow>(() => dayWindow(new Date(), Date.now()))

  // The full calendar-day bounds (used for clamp targets in D3 zoom/pan).
  const computedDayBounds = useMemo(() => dayWindow(day, Date.now()), [day])

  const handleDayChange = useCallback((d: Date): void => {
    setDay(d)
    setView(dayWindow(d, Date.now()))
    setSelectedBucket(null)
  }, [])

  const handleViewChange = useCallback((w: DayWindow): void => {
    setView(w)
    setSelectedBucket(null)
  }, [])

  // D3: wheel-pan — horizontal scroll or shift+vertical scroll pans the view.
  const trackAreaRef = useRef<HTMLDivElement>(null)

  const handleWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>): void => {
      const deltaX = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (deltaX === 0) return
      e.preventDefault()
      const deltaMs = deltaX * PAN_MS_PER_PX
      setView((current) => panWindow(current, computedDayBounds, deltaMs))
    },
    [computedDayBounds],
  )

  // D3: adaptive bucketing — bucket size scales with the visible span.
  const bucketMs = bucketMsForSpan(view.toMs - view.fromMs)

  // OURS, by name (D625). The admin Recordings page is the recorder's own
  // surface; the per-camera source picker lives in the viewer.
  const availabilityQuery = useRecordingGetAvailability({
    deviceId,
    provider: RECORDING_SOURCE_CAMSTACK_ADDON,
    fromMs: view.fromMs,
    toMs: view.toMs,
  })

  const eventDensityQuery = usePipelineAnalyticsGetEventDensity({
    deviceId,
    since: view.fromMs,
    until: view.toMs,
    bucketMs,
  })

  // An `unreadable` answer is NOT an empty bar. Drawing it as one is the
  // failure D393 names: "no footage" where the truth is "nobody looked".
  const availabilityUnreadable = availabilityQuery.data?.read === 'unreadable'
  const ranges =
    availabilityQuery.data?.read === 'read' ? availabilityQuery.data.ranges : EMPTY_RANGES
  const spans = useMemo(() => mergeAvailabilitySpans(ranges), [ranges])

  const buckets = useMemo(
    () => densityRowsToBuckets(eventDensityQuery.data ?? [], view.fromMs, bucketMs),
    [eventDensityQuery.data, view.fromMs, bucketMs],
  )

  // Selection uses logical bucket index (stable across background refetches)
  // rather than array position, because the buckets array is now sparse.
  const selected =
    selectedBucket !== null ? buckets.find((b) => b.index === selectedBucket) : undefined

  // Drill-down: three per-bucket queries enabled only when a bucket is selected.
  const drillEnabled = selected !== undefined
  // Clamp the drill window to the view boundary.
  const drillSince = selected?.startMs ?? 0
  const drillUntil = selected ? Math.min(selected.endMs, view.toMs) : 0
  const objectDrill = usePipelineAnalyticsGetObjectEvents(
    { deviceId, since: drillSince, until: drillUntil, limit: pageLimit, projection: 'slim' },
    { enabled: drillEnabled && enabledKinds.has('object') },
  )
  const motionDrill = usePipelineAnalyticsGetMotionEvents(
    { deviceId, since: drillSince, until: drillUntil, limit: pageLimit, projection: 'slim' },
    { enabled: drillEnabled && enabledKinds.has('motion') },
  )
  const audioDrill = usePipelineAnalyticsGetAudioEvents(
    { deviceId, since: drillSince, until: drillUntil, limit: pageLimit, projection: 'slim' },
    { enabled: drillEnabled && enabledKinds.has('audio') },
  )

  // Clips for the drill-down strip: enabled kinds only.
  const bucketClips = useMemo<BucketClip[]>(() => {
    if (!selected) return []
    const out: BucketClip[] = []
    if (enabledKinds.has('object')) {
      for (const e of objectDrill.data ?? []) {
        out.push({
          // `BucketClip.id` is a React key and half of the `event:<id>`
          // playback key, so it stays text; event ids themselves are numbers
          // (D474).
          id: String(e.id),
          timestamp: e.timestamp,
          kind: 'object',
          label: e.label ?? e.className,
          mediaUrl: e.mediaUrl,
        })
      }
    }
    if (enabledKinds.has('motion')) {
      for (const e of motionDrill.data ?? []) {
        out.push({
          // `BucketClip.id` is a React key and half of the `event:<id>`
          // playback key, so it stays text; event ids themselves are numbers
          // (D474).
          id: String(e.id),
          timestamp: e.timestamp,
          kind: 'motion',
          label: t('uiLibrary.recordingTimeline.motionClip', 'Motion ({{count}})', {
            count: e.regionCount,
          }),
          mediaUrl: e.mediaUrl,
        })
      }
    }
    if (enabledKinds.has('audio')) {
      for (const e of audioDrill.data ?? []) {
        out.push({
          // `BucketClip.id` is a React key and half of the `event:<id>`
          // playback key, so it stays text; event ids themselves are numbers
          // (D474).
          id: String(e.id),
          timestamp: e.timestamp,
          kind: 'audio',
          label: e.classification?.className ?? t('uiLibrary.recordingTimeline.audioClip', 'Audio'),
          mediaUrl: e.mediaUrl,
        })
      }
    }
    return out.toSorted((a, b) => b.timestamp - a.timestamp)
  }, [selected, enabledKinds, objectDrill.data, motionDrill.data, audioDrill.data, t])

  // hasMore: any enabled kind returned exactly pageLimit results (more may exist).
  const hasMore = useMemo(() => {
    if (enabledKinds.has('object') && (objectDrill.data?.length ?? 0) === pageLimit) return true
    if (enabledKinds.has('motion') && (motionDrill.data?.length ?? 0) === pageLimit) return true
    if (enabledKinds.has('audio') && (audioDrill.data?.length ?? 0) === pageLimit) return true
    return false
  }, [enabledKinds, objectDrill.data, motionDrill.data, audioDrill.data, pageLimit])

  const playWindow = useCallback(
    async (
      key: string,
      fromMs: number,
      toMs: number,
      label: string,
      headMs: number,
    ): Promise<void> => {
      setBusyKey(key)
      setPlaybackError(null)
      try {
        const playback = await system.trpcClient.recording.getPlayback.query({
          deviceId,
          provider: RECORDING_SOURCE_CAMSTACK_ADDON,
          fromMs,
          toMs,
        })
        // Ours answers `hls` and nothing else. Any other arm carries its own
        // reason and is shown verbatim rather than flattened (D391).
        if (playback.kind === 'hls' && playback.manifest.playbackUrl) {
          setPlayheadMs(headMs)
          vod.play({ url: playback.manifest.playbackUrl, label })
        } else {
          setPlaybackError(
            playback.kind === 'none'
              ? `No playable footage for this selection — ${playback.reason}`
              : 'No playable footage for this selection.',
          )
        }
      } catch {
        setPlaybackError('Could not load this recording.')
      } finally {
        setBusyKey(null)
      }
    },
    [system, deviceId, vod],
  )

  const handleSeek = useCallback(
    (clickMs: number): void => {
      const target = seekTargetForSpans(clickMs, spans)
      if (!target) return
      if (framePushRef.current) {
        // Frame-push: one epoch-ms seek over the control channel — the server
        // feeder locates the segment and frames resume on the live <video>.
        scrubSeek(target.fromMs, 'timeline')
        return
      }
      const label = `Recording · ${new Date(target.fromMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      void playWindow(`seek:${target.fromMs}`, target.fromMs, target.toMs, label, target.fromMs)
    },
    [spans, playWindow, scrubSeek],
  )

  // Drag-scrub bindings for the coverage track (frame-push only). Moves are
  // throttled by the controller; release snaps into the nearest recorded span
  // (same policy as a click) and commits ONE `scrubCommit` to the feeder.
  const handleScrubStart = useCallback((): void => {
    beginScrub('timeline')
  }, [beginScrub])
  const handleScrubMove = useCallback(
    (ms: number): void => {
      updateScrub(ms, 'timeline')
    },
    [updateScrub],
  )
  const handleScrubEnd = useCallback(
    (ms: number): void => {
      const target = seekTargetForSpans(ms, spans)
      endScrub(target?.fromMs ?? ms, 'timeline')
    },
    [spans, endScrub],
  )

  const handlePlayClip = useCallback(
    (clip: BucketClip): void => {
      if (framePushRef.current) {
        scrubSeek(clip.timestamp - EVENT_PRE_MS, 'timeline')
        return
      }
      const label = `${clip.label} · ${new Date(clip.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
      // `playWindow`'s first arg is a busy/UI key only, never a media-owner
      // key — but D476 means a bare numeric id is no longer unique across
      // motion/object/audio, so it is still prefixed with the clip's own
      // kind (matches `EventBucketStrip`'s `busyKey`) rather than a guessed
      // `event:` that could collide with a different kind's same-numbered id.
      void playWindow(
        `${clip.kind}:${clip.id}`,
        clip.timestamp - EVENT_PRE_MS,
        clip.timestamp + EVENT_POST_MS,
        label,
        clip.timestamp,
      )
    },
    [playWindow, scrubSeek],
  )

  const handleSelectBucket = useCallback((index: number): void => {
    setSelectedBucket((cur) => (cur === index ? null : index))
  }, [])

  const coverageLoading = availabilityQuery.isLoading
  const densityLoading = eventDensityQuery.isLoading
  const drillLoading =
    (objectDrill.isLoading || motionDrill.isLoading || audioDrill.isLoading) && drillEnabled

  // D4 — absolute-time axis ticks (recalculated when view changes)
  const ticks = useMemo(() => axisTicks(view.fromMs, view.toMs, 5), [view.fromMs, view.toMs])

  // Playhead shown on the coverage track: in frame-push mode the drag target
  // wins while scrubbing, else the server's ~1 Hz position; in HLS mode the
  // locally tracked seek head (legacy behaviour).
  const displayPlayheadMs = framePush
    ? scrubState.scrubbing
      ? scrubState.scrubEpoch
      : scrubState.playheadEpoch
    : playheadMs
  const showRateToggle = framePush && (recordedMode === 'playing' || recordedMode === 'paused')

  return (
    <div className="space-y-3">
      {availabilityQuery.isError ? (
        <ErrorBox
          variant="warning"
          message={t(
            'uiLibrary.recordingTimeline.recorderUnavailable',
            'Recorder unavailable — the recording service may not be running for this node.',
          )}
        />
      ) : null}
      {availabilityUnreadable ? (
        <ErrorBox
          variant="warning"
          message={t(
            'uiLibrary.recordingTimeline.availabilityUnreadable',
            "CamStack could not be asked about this camera's recordings — this bar shows nothing, which is not the same as no footage.",
          )}
        />
      ) : null}
      {playbackError ? <ErrorBox variant="warning" message={playbackError} /> : null}

      {/* D2: Controls row (date selector) */}
      <TimelineControls
        day={day}
        onDayChange={handleDayChange}
        view={view}
        dayBounds={computedDayBounds}
        onViewChange={handleViewChange}
      />

      {/* The frame at the playhead, into a training collection — including a
          moment where the model saw nothing. Draws nothing without the admin
          collection list. */}
      <div className="flex justify-end">
        <SendFrameToTrainingButton deviceId={deviceId} epochMs={displayPlayheadMs} />
      </div>

      {/* R9: frame-push playback status row — only when the hero player's
          control channel is available. Mode chip + position, pause/resume,
          Go-Live return, and the explicit HLS fallback toggle. */}
      {recorded.channelOpen ? (
        <div
          data-testid="frame-push-status-row"
          className="flex flex-wrap items-center gap-2 text-[10px]"
        >
          <span
            data-testid="frame-push-mode-chip"
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider ${
              framePush && recordedMode !== 'live'
                ? recordedMode === 'error'
                  ? 'bg-rose-500/15 text-rose-400'
                  : 'bg-primary/15 text-primary'
                : 'bg-background/40 text-foreground-subtle'
            }`}
          >
            {framePush
              ? modeLabel(t, recordedMode)
              : t('uiLibrary.recordingTimeline.hlsMode', 'HLS mode')}
          </span>
          {framePush && recordedPositionMs !== null && !scrubState.scrubbing ? (
            <span className="tabular-nums text-foreground-subtle">
              {new Date(recordedPositionMs).toLocaleTimeString()}
            </span>
          ) : null}
          {showRateToggle ? (
            <button
              type="button"
              data-testid="frame-push-rate-toggle"
              onClick={handleRateToggle}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
              title={
                recordedMode === 'paused'
                  ? t('uiLibrary.recordingTimeline.resumeTitle', 'Resume playback')
                  : t('uiLibrary.recordingTimeline.pauseTitle', 'Pause playback')
              }
            >
              {recordedMode === 'paused' ? (
                <Play className="h-3 w-3" />
              ) : (
                <Pause className="h-3 w-3" />
              )}
              {recordedMode === 'paused'
                ? t('uiLibrary.recordingTimeline.resume', 'Resume')
                : t('uiLibrary.recordingTimeline.pause', 'Pause')}
            </button>
          ) : null}
          {framePush && recordedMode !== 'live' ? (
            <button
              type="button"
              data-testid="frame-push-go-live"
              onClick={handleGoLive}
              className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 font-medium text-danger transition-colors hover:bg-danger/20"
              title={t('uiLibrary.recordingTimeline.liveTitle', 'Return to the live stream')}
            >
              <Radio className="h-3 w-3" />
              {t('uiLibrary.recordingTimeline.goLive', 'Go live')}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="frame-push-hls-toggle"
            onClick={() => setForceHls((v) => !v)}
            className={`ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium transition-colors ${
              forceHls
                ? 'bg-primary/15 text-primary'
                : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
            }`}
            title={t(
              'uiLibrary.recordingTimeline.hlsTitle',
              'Play recordings through the HLS player instead of the live WebRTC session',
            )}
          >
            HLS
          </button>
        </div>
      ) : null}

      {/* D3: wheel-pannable track area */}
      <div ref={trackAreaRef} onWheel={handleWheel} className="space-y-1">
        {/* Coverage track */}
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
            {t('uiLibrary.recordingTimeline.recorded', 'Recorded')}
          </div>
          {coverageLoading ? (
            <div className="h-5 animate-pulse rounded bg-background/40" />
          ) : spans.length === 0 ? (
            <EmptyState
              icon={Film}
              title={t(
                'uiLibrary.recordingTimeline.noRecordings',
                'No recordings for this window.',
              )}
            />
          ) : (
            <CoverageTrack
              windowFrom={view.fromMs}
              windowTo={view.toMs}
              spans={spans}
              playheadMs={displayPlayheadMs}
              onSeek={handleSeek}
              {...(framePush
                ? {
                    onScrubStart: handleScrubStart,
                    onScrubMove: handleScrubMove,
                    onScrubEnd: handleScrubEnd,
                  }
                : {})}
            />
          )}
        </div>

        {/* Event-density heatmap */}
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
            {t('uiLibrary.recordingTimeline.density', 'Events · density')}
          </div>
          {densityLoading ? (
            <div className="h-6 animate-pulse rounded bg-background/40" />
          ) : (
            <EventHeatmap
              windowFrom={view.fromMs}
              windowTo={view.toMs}
              buckets={buckets}
              selectedIndex={selectedBucket}
              onSelectBucket={handleSelectBucket}
            />
          )}
        </div>

        {/* D4 — absolute-time axis */}
        <div className="relative h-3">
          {ticks.map((tick) => (
            <span
              key={tick.pct}
              className="absolute -translate-x-1/2 text-[9px] text-foreground-subtle"
              style={{ left: `${tick.pct}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>

      {/* Drill-down strip */}
      {selected ? (
        <EventBucketStrip
          clips={bucketClips}
          loading={drillLoading}
          busyKey={busyKey}
          onPlay={handlePlayClip}
          enabledKinds={enabledKinds}
          onToggleKind={toggleKind}
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
        />
      ) : (
        <p className="text-[11px] text-foreground-subtle">
          {framePush
            ? t(
                'uiLibrary.recordingTimeline.helpFramePush',
                'Click or drag the coverage bar to play from any point (frames play in the main player above), or click a density bar to browse that window’s events.',
              )
            : t(
                'uiLibrary.recordingTimeline.helpHls',
                'Click the coverage bar to play from any point, or a density bar to browse that window’s events.',
              )}
        </p>
      )}
    </div>
  )
}
