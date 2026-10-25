/**
 * EventDetailPanel — the Detection Intelligence "Events" detail modal for a
 * single scored track.
 *
 * ## Layout (mirrors FaceDetailPanel)
 * A top-layer `Dialog` (`<dialog showModal()>` — viewport-anchored, never
 * clipped by the page's inner `relative`/overflow ancestors), centered card on
 * desktop, full-width bottom sheet on mobile (`placement="sheet-on-mobile"` plus
 * the co-existing hand-rolled override classes as a framework-train-gap fallback,
 * same as FaceDetailPanel). Fixed header + footer, scrollable body.
 *
 * ## Content
 * - Hero: the track's native-resolution `keyFrame` (fetched off the admin-gated
 *   event-media data-plane via `useAuthedImage`, since `<img>` can't carry the
 *   Bearer header), with the trajectory painted over it as a 0..100 viewBox SVG
 *   (`buildTrajectoryOverlay`) — polyline + per-position dots + snapshot
 *   checkpoints + start/end markers + peak box, stretched to the frame
 *   (`preserveAspectRatio="none"`). The trail coords live in DETECTION frame
 *   pixel space (e.g. 640×360), NOT the native key frame's, so they are
 *   normalized against the detection dims recovered from a detection-resolution
 *   track media — otherwise painting them over a 1920×1080 hero drops the trail
 *   in the wrong place. Falls back to the event's `fullFrameBoxed`, then any
 *   `crop`, then an icon placeholder.
 * - Filmstrip: the UNION of `listEventMedia({ownerType: 'object', eventId})` +
 *   `listTrackMedia(trackId)`, deduped by `mediaId` (D482); each thumb renders
 *   from the row's own server-minted `url`. Neither call carries bytes — this
 *   panel cannot render base64 even by mistake.
 *
 *   The `eventId` for `listEventMedia` comes from the freshly-fetched
 *   `track.bestEventId` (the track's representative ObjectEvent id per the
 *   `TrackSchema` docblock — always `ownerType: 'object'` when present), NOT
 *   from `row.bestEventId`: this panel is typed on `TrackSubject`, whose
 *   `bestEventId` is a looser structural field some producers (the CLIP
 *   search adapter) do not populate the same way. `track` is the one read
 *   this panel already trusts for the trajectory, so it is the one source of
 *   the numeric event id too.
 *
 *   `listTrackMedia` is the manifest twin of `getTrackMedia`: the same rows with
 *   `base64` omitted. Measured on the live hub over 12 real key events
 *   (2026-08-25), per panel open: `getTrackMedia` averaged **3,931,414 B and
 *   824 ms**, against **1,228 B and 78 ms** for the manifest — the JPEGs then
 *   ride the browser's HTTP cache off `/addon/pipeline-analytics/event-media/…`,
 *   which answers `Cache-Control: immutable` + an ETag, in parallel, instead of
 *   arriving as one 4 MB `JSON.stringify` on hub-main's event loop. Re-opening
 *   the same event costs zero image bytes.
 *
 *   Clicking one swaps the hero to that frame (`heroOverride`); the trail
 *   re-renders over any full-frame pick (native or 640×360), suppressed only on
 *   crop sub-regions. Snapshot checkpoints are click-targets that swap to their
 *   captured frame.
 * - Clip link: `videoclips.listClips`, for the provider the camera's own
 *   `listSources` names first (required since D554 amended), padded around the event
 *   window; a "View
 *   clip" button resolves `getClipPlayback` and opens the HLS URL in a new tab
 *   (inline player is a v2 non-goal). Hidden when no clip covers the window.
 * - Metadata rows + whole-track Delete (confirm → `deleteTracks` → `onDeleted`).
 */

import {
  Button,
  Dialog,
  DialogContent,
  useAlert,
  useConfirm,
  usePipelineAnalyticsGetTrack,
  usePipelineAnalyticsListEventMedia,
  usePipelineAnalyticsListTrackMedia,
  useSystem,
  useVideoclipsListClips,
  useVideoclipsListSources,
} from '@camstack/ui-library'
import { Film, ImageOff, Loader2, Trash2 } from 'lucide-react'
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react'
import { useAuthedImage } from '../../lib/authed-media.js'
import { formatClockTime, formatFaceTimestampFull } from '../../lib/face-gallery-filters.js'
import { CopyUrlChips } from './CopyUrlChips.js'
import { buildMediaUrl, mediaKindLabel } from './event-media-labels.js'
import { rowDisplayLabel } from './key-events-merge.js'
import { describePreviewMiss } from './media-provenance.js'
import { usePublicMediaOrigin } from './PublicMediaOrigin.js'
import { TrackFlagToggles } from './TrackFlagToggles.js'
import { type TrackPlacementRowKind, trackPlacementRows } from './track-placement-rows.js'
import type { TrackSubject } from './track-subject.js'
import { buildTrajectoryOverlay, type TrajectoryOverlay } from './trajectory-overlay.js'
import { DELETE_UNAVAILABLE_TITLE, useDeleteTracksMutation } from './use-delete-tracks.js'
import type { TrackFlagsResult } from './use-track-flags.js'
import { ZoomableImage } from './ZoomableImage.js'
import { hubOrigin } from '../../lib/mount'
import { useTranslation } from 'react-i18next'

/** Padding around the event window when searching for a covering clip. */
const CLIP_PAD_MS = 15_000

interface EventDetailPanelProps {
  /**
   * The track to show. A {@link TrackSubject}, deliberately NOT the events
   * feed's `KeyEventRow`: this is the ONE track detail surface in the admin UI
   * and any screen holding a track opens it — the Events feed, the semantic
   * search, and the Debug tab. `KeyEventRow` satisfies it structurally.
   */
  readonly row: TrackSubject | null
  readonly cameraName: string
  readonly deleteAvailable: boolean
  readonly onClose: () => void
  readonly onDeleted: () => void
  /** Fires after an operator flag write lands, with the server-resolved pair,
   *  so the grid row behind the panel stops showing the pre-write state. */
  readonly onFlagsChanged?: (flags: TrackFlagsResult) => void
}

/**
 * One media row of the filmstrip.
 *
 * There is no `base64` here and there is no longer anywhere to get one: BOTH
 * listings this panel reads are manifests (`listTrackMedia`, `listEventMedia`),
 * so a byte can no longer arrive by accident and be rendered by accident.
 * Every pixel on this panel comes from the event-media data plane, at the
 * row's own server-minted {@link MediaFileLite.url} (D482) — never
 * reconstructed from {@link MediaFileLite.mediaId} here.
 */
interface MediaFileLite {
  readonly mediaId: number
  readonly kind: string
  readonly timestamp: number
  readonly url: string
}

/** The hub base the admin UI is served from — origin plus its mount. */
const LOCAL_ORIGIN = hubOrigin()

/**
 * One filmstrip tile, painted from the event-media data plane at the row's
 * own server-minted `url` (D482).
 *
 * Its own component because `useAuthedImage` is a hook and the strip is a
 * `.map()` — and because each tile then owns its own load/revoke lifecycle
 * instead of one parent effect juggling N object URLs.
 *
 * The stored blob is served verbatim (no `?variant=thumb`): the strip is a
 * pick-a-frame control, and the plane's thumb variant is a CENTER-CROPPED
 * SQUARE, which on this 2:1 tile would cut a second time and make two full
 * frames indistinguishable. The bytes are the same ones today's base64 already
 * carried — but they now arrive in parallel, uninflated, and `immutable`, so a
 * re-open of the same event costs nothing.
 */
function FilmstripThumb({
  url,
  label,
}: {
  readonly url: string
  readonly label: string
}): JSX.Element {
  const { src, failed } = useAuthedImage(url)
  if (src === null) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-hover">
        {failed ? (
          <ImageOff className="h-4 w-4 text-foreground-subtle opacity-60" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-foreground-subtle opacity-70" />
        )}
      </div>
    )
  }
  return <img src={src} alt={label} className="h-full w-full object-cover" />
}

interface NaturalSize {
  readonly width: number
  readonly height: number
}

/**
 * Media kinds encoded at the DETECTION frame resolution (e.g. 640×360). Their
 * intrinsic size is exactly the pixel space the track `positions`/`snapshots`
 * live in, so any one of them yields the source dims for the trajectory
 * normalization — independent of which (possibly native-res) frame the hero
 * currently shows.
 */
const DETECTION_RES_KINDS: ReadonlySet<string> = new Set([
  'firstFrame',
  'lastFrame',
  'thumbnail',
  'snapshot',
])

/**
 * Media kinds that show the WHOLE frame (detection-res or native-res) and thus
 * share the detection frame's aspect — the trajectory (normalized against the
 * detection dims, stretched with `preserveAspectRatio="none"`) lines up on any
 * of them. Crop kinds (`crop`/`faceCrop`/`plateCrop`) are sub-regions with a
 * different coordinate space, so the trail must NOT be painted over them.
 */
const FULL_FRAME_KINDS: ReadonlySet<string> = new Set([
  'keyFrame',
  'fullFrame',
  'fullFrameBoxed',
  'firstFrame',
  'lastFrame',
  'thumbnail',
  'snapshot',
  // The clean twins of the boxed timeline tiles (D654) — same frame, no box.
  'sceneFrame',
  'lastSceneFrame',
])

// ── Detection-frame natural size (px space the track positions live in) ───────

/**
 * Reads the intrinsic pixel dimensions of the loaded `src` (an object URL or
 * data URI). Passed a DETECTION-resolution sample frame, it yields the source
 * dims the trajectory overlay divides positions by (mirroring
 * `face-bbox.ts#normalizeFaceBbox`) to land in the shared 0..1 → 0..100
 * viewBox. `null` while the image hasn't decoded yet → overlay stays blank.
 */
function useImageNaturalSize(src: string | null): NaturalSize | null {
  const [size, setSize] = useState<NaturalSize | null>(null)
  useEffect(() => {
    setSize(null)
    if (!src) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setSize({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.src = src
    return () => {
      cancelled = true
      img.onload = null
    }
  }, [src])
  return size
}

// ── Trajectory SVG (normalized 0..100 space, stretched over the hero) ─────────

function TrajectorySvg({
  overlay,
  onPickSnapshot,
}: {
  readonly overlay: TrajectoryOverlay
  /** Optional: click a snapshot checkpoint to swap the hero to that frame. */
  readonly onPickSnapshot?: (mediaId: number) => void
}): JSX.Element | null {
  const { t } = useTranslation()
  if (!overlay.polyline && !overlay.peakBox && overlay.snapshots.length === 0) return null
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {overlay.peakBox && (
        <rect
          x={overlay.peakBox.x}
          y={overlay.peakBox.y}
          width={overlay.peakBox.w}
          height={overlay.peakBox.h}
          fill="none"
          stroke="var(--color-warning)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          rx={1}
        />
      )}
      {overlay.polyline && (
        <polyline
          points={overlay.polyline}
          fill="none"
          stroke="var(--color-info)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeOpacity={0.85}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* One subtle dot per sampled position, oldest→newest. */}
      {overlay.points.map((p, i) => (
        <circle
          key={`${String(p.x)}-${String(p.y)}-${String(i)}`}
          cx={p.x}
          cy={p.y}
          r={1}
          fill="var(--color-info)"
          fillOpacity={0.6}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {/* Snapshot checkpoints along the path (start → snapshot → … → end).
          Larger, bordered dots distinguish them from the faint per-position
          trail; when a picker is wired they are click-targets that swap the
          hero to that captured frame (svg is pointer-events-none, so each
          marker re-enables pointer-events on itself). */}
      {overlay.snapshots.map((s, i) => (
        <circle
          key={`snap-${String(s.mediaId)}-${String(i)}`}
          cx={s.x}
          cy={s.y}
          r={1.9}
          fill="var(--color-info)"
          fillOpacity={0.95}
          stroke="var(--color-background)"
          strokeWidth={0.7}
          vectorEffect="non-scaling-stroke"
          className={onPickSnapshot ? 'pointer-events-auto cursor-pointer' : undefined}
          onClick={
            onPickSnapshot
              ? (e) => {
                  e.stopPropagation()
                  onPickSnapshot(s.mediaId)
                }
              : undefined
          }
        >
          <title>
            {t(
              'detectionIntelligence.eventDetailPanel.snapshotCheckpointClickToView',
              'Snapshot checkpoint — click to view this frame',
            )}
          </title>
        </circle>
      ))}
      {overlay.start && (
        <circle
          cx={overlay.start.x}
          cy={overlay.start.y}
          r={2.4}
          fill="var(--color-success)"
          stroke="var(--color-background)"
          strokeWidth={0.6}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {overlay.end && (
        <circle
          cx={overlay.end.x}
          cy={overlay.end.y}
          r={2.4}
          fill="var(--color-danger)"
          stroke="var(--color-background)"
          strokeWidth={0.6}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  )
}

// ── Metadata row ──────────────────────────────────────────────────────────────

function MetaRow({
  label,
  value,
  mono,
  wrap,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
  /** Wrap a long value instead of truncating it — for a value that is only
   *  useful whole (a phone has no hover to read the `title`). */
  readonly wrap?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-foreground-subtle">
        {label}
      </span>
      <span
        className={`min-w-0 ${wrap ? 'break-words' : 'truncate'} text-right text-xs font-medium text-foreground ${mono ? 'font-mono text-[11px]' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function EventDetailPanel({
  row,
  cameraName,
  deleteAvailable,
  onClose,
  onDeleted,
  onFlagsChanged,
}: EventDetailPanelProps): JSX.Element | null {
  const { t } = useTranslation()
  const system = useSystem()
  const showAlert = useAlert()
  const confirm = useConfirm()
  const del = useDeleteTracksMutation()

  const enabled = row !== null
  const deviceId = row?.deviceId ?? 0
  const trackId = row?.trackId ?? ''
  const timestamp = row?.timestamp ?? 0
  const windowMs = row?.windowMs ?? 0

  const { data: track } = usePipelineAnalyticsGetTrack({ deviceId, trackId }, { enabled })
  // MANIFEST, not bytes. See the filmstrip note in the module docblock: the
  // byte-bearing `getTrackMedia` averaged 3.93 MB / 824 ms per open.
  const { data: trackMedia } = usePipelineAnalyticsListTrackMedia(
    { trackId, deviceId },
    { enabled },
  )
  // `track.bestEventId` — NOT `row.bestEventId` — is the numeric ObjectEvent
  // id this call needs (D482: `listEventMedia` takes a REQUIRED `ownerType`,
  // and an owner is `(table, id)`). It is read off the freshly-fetched track
  // because that field's cap docblock specifically documents it as the
  // track's representative ObjectEvent id; the `TrackSubject` prop's
  // `bestEventId` carries no such guarantee across every producer of that
  // structural interface (see the module docblock).
  const eventId = track?.bestEventId !== undefined ? Number(track.bestEventId) : undefined
  const hasEventId = eventId !== undefined && Number.isFinite(eventId)
  // MANIFEST on this side too. It was the last byte-bearing read on the
  // heaviest surface in the app: an old-style event owns a native-resolution
  // `fullFrameBoxed` (measured 2 824 077 B, ~3.8 MB base64) and this panel
  // never read a byte of it — every tile below renders from its own `url`.
  const { data: eventMedia } = usePipelineAnalyticsListEventMedia(
    { ownerType: 'object', eventId: eventId ?? 0, deviceId },
    { enabled: enabled && hasEventId },
  )
  // `listClips` NAMES its provider (D554 amended). There is no default to fall back
  // on: a collection cap's binding set is derived and plural, so a bare call
  // used to fan out over every source a camera has — on 107 that meant this
  // panel's `clips[0]` could be an SD-card file under an analytics event.
  // The id comes from the camera's own source list, never from a table here.
  const { data: clipSources } = useVideoclipsListSources({ deviceId }, { enabled })
  const clipProvider = (clipSources ?? []).find((row) => row.addonId !== undefined)?.addonId
  const { data: clips } = useVideoclipsListClips(
    {
      deviceId,
      since: timestamp - CLIP_PAD_MS,
      until: timestamp + windowMs + CLIP_PAD_MS,
      provider: clipProvider ?? '',
    },
    // A camera that lists no source has nobody to ask, and an unanswerable
    // question is not asked.
    { enabled: enabled && clipProvider !== undefined },
  )

  // The filmstrip frame the operator picked (carries its `kind` so the
  // trajectory gating knows whether the shown image is a full frame or a crop).
  const [heroOverride, setHeroOverride] = useState<MediaFileLite | null>(null)
  const [clipPending, setClipPending] = useState(false)

  // Public tunnel origin (if a network-access tunnel is up) for shareable
  // event-media URLs. `probes` are invisible query drivers rendered below.
  const { publicOrigin, probes: publicOriginProbes } = usePublicMediaOrigin(enabled)

  // A fresh row must reset the manual filmstrip override.
  useEffect(() => {
    setHeroOverride(null)
  }, [deviceId, trackId])

  // Hero source: native key frame → event fullFrameBoxed → any crop.
  const heroFile = useMemo<MediaFileLite | null>(() => {
    const tm: readonly MediaFileLite[] = trackMedia ?? []
    const em: readonly MediaFileLite[] = eventMedia ?? []
    const keyFrame = tm.find((m) => m.kind === 'keyFrame')
    if (keyFrame) return keyFrame
    const boxed = em.find((m) => m.kind === 'fullFrameBoxed')
    if (boxed) return boxed
    const crop = [...em, ...tm].find((m) => m.kind === 'crop')
    return crop ?? null
  }, [trackMedia, eventMedia])

  // The frame actually on screen: the filmstrip pick, else the resolved hero.
  // ONE fetch drives both — picking a frame used to render its inline base64
  // while this hook went on loading the un-picked key frame anyway. `url` is
  // the row's own server-minted plane path (D482) — never rebuilt here.
  const heroDisplayFile = heroOverride ?? heroFile
  const hero = useAuthedImage(heroDisplayFile ? heroDisplayFile.url : undefined)

  // Filmstrip: union of event + track media, deduped by mediaId (D482 — a
  // row's own id, never its old composite key).
  //
  // The gate is a defined `mediaId`, not the presence of inline bytes. It
  // used to be `if (!m.base64) continue`, which silently dropped every row
  // of a manifest — so leaving that line in place while switching to
  // `listTrackMedia` would have emptied the strip rather than sped it up.
  const filmstrip = useMemo<MediaFileLite[]>(() => {
    const seen = new Set<number>()
    const out: MediaFileLite[] = []
    for (const m of [...(eventMedia ?? []), ...(trackMedia ?? [])]) {
      if (seen.has(m.mediaId)) continue
      seen.add(m.mediaId)
      out.push(m)
    }
    return out
  }, [eventMedia, trackMedia])

  // Track positions/snapshots live in DETECTION frame pixel space, which is NOT
  // the (now native-res) hero's intrinsic size. Recover the detection dims from
  // any detection-resolution track/event media (they are encoded at exactly the
  // detection frame resolution). Without one, we can't normalize honestly, so
  // the trajectory degrades to blank rather than landing in the wrong place.
  const detectionSample = useMemo<MediaFileLite | null>(
    () => filmstrip.find((m) => DETECTION_RES_KINDS.has(m.kind)) ?? null,
    [filmstrip],
  )
  // Off the data plane, like everything else here. `useImageNaturalSize` only
  // needs the intrinsic dims, and the blob it measures is the SAME bytes the
  // filmstrip tile already pulled — so the browser cache serves it twice for one
  // download.
  const detectionSampleImage = useAuthedImage(detectionSample ? detectionSample.url : undefined)
  const frameDims = useImageNaturalSize(detectionSampleImage.src)

  const overlay = useMemo(
    () =>
      buildTrajectoryOverlay(track?.positions ?? [], frameDims, {
        snapshots: (track?.snapshots ?? []).map((s) => ({
          x: s.position.x,
          y: s.position.y,
          mediaId: s.mediaId,
        })),
      }),
    [track?.positions, track?.snapshots, frameDims],
  )

  // Swap the hero to a captured snapshot frame (clicked on the trajectory).
  const pickSnapshotFrame = useCallback(
    (mediaId: number) => {
      const m = filmstrip.find((f) => f.mediaId === mediaId)
      if (m) setHeroOverride(m)
    },
    [filmstrip],
  )

  if (row === null) return null

  const heroSrc = hero.src
  const displayedKind = heroDisplayFile?.kind
  // Paint the trail over ANY full frame (native key frame or a 640×360
  // detection frame the operator swapped to) — it is normalized against the
  // detection dims and stretched with `preserveAspectRatio="none"`, so it lines
  // up on either. Suppress on crop sub-regions and until the detection dims are
  // known. Gate on ≥2 positions so a track with no/one position renders no trail.
  const showTrajectory =
    displayedKind !== undefined &&
    FULL_FRAME_KINDS.has(displayedKind) &&
    frameDims !== null &&
    (track?.positions.length ?? 0) >= 2

  const clip = clips && clips.length > 0 ? clips[0] : null

  const openClip = () => {
    if (!clip) return
    setClipPending(true)
    void (async () => {
      try {
        const playback = await system.trpcClient.videoclips.getClipPlayback.query({
          deviceId: row.deviceId,
          clipId: clip.id,
        })
        window.open(playback.playbackUrl, '_blank', 'noopener')
      } catch {
        void showAlert({
          title: t('detectionIntelligence.eventDetailPanel.clipUnavailable', 'Clip unavailable'),
          message: t(
            'detectionIntelligence.eventDetailPanel.couldNotResolveClipPlayback',
            'Could not resolve clip playback. Check the server logs.',
          ),
          variant: 'warning',
        })
      } finally {
        setClipPending(false)
      }
    })()
  }

  const runDelete = () => {
    if (!deleteAvailable || del.isPending) return
    void (async () => {
      const ok = await confirm({
        title: t('detectionIntelligence.eventDetailPanel.deleteTrack', 'Delete track'),
        message: t(
          'detectionIntelligence.eventDetailPanel.deleteThisTrackAndEvery',
          'Delete this track and every image and clip captured for it? This cannot be undone.',
        ),
        confirmLabel: t('common.delete', 'Delete'),
        variant: 'danger',
      })
      if (!ok) return
      try {
        await del.mutateAsync({ deviceId: row.deviceId, trackIds: [row.trackId] })
        onDeleted()
      } catch {
        await showAlert({
          title: t('detectionIntelligence.eventDetailPanel.deleteFailed', 'Delete failed'),
          message: t(
            'detectionIntelligence.eventDetailPanel.failedToDeleteThisTrack',
            'Failed to delete this track. Check the server logs.',
          ),
          variant: 'danger',
        })
      }
    })()
  }

  const importancePct = Math.round(row.importance * 100)
  const importanceValue = track?.importanceReason
    ? `${String(importancePct)}% · ${track.importanceReason}`
    : `${String(importancePct)}%`
  const zonesValue =
    track?.zonesVisited && track.zonesVisited.length > 0 ? track.zonesVisited.join(', ') : '—'
  // Audio-classification labels heard on the camera during the track's life
  // (confident episodes only, aggregated server-side per label).
  // Prefer the full track (has counts/scores); fall back to the feed row so an
  // audio card still names what was heard before `getTrack` lands (D189).
  const audioLabelsForMeta =
    track?.audioLabels && track.audioLabels.length > 0
      ? track.audioLabels
      : row.audioLabels && row.audioLabels.length > 0
        ? row.audioLabels
        : undefined
  const audioValue =
    audioLabelsForMeta !== undefined
      ? audioLabelsForMeta
          .map((a) => `${a.label} ×${String(a.count)} (${String(Math.round(a.peakScore * 100))}%)`)
          .join(' · ')
      : '—'
  const distanceValue = track ? track.totalDistance.toFixed(2) : '—'
  // D276, straight off the track the panel already fetched for the trajectory —
  // no extra read, and no cap change: `previewMissReason` is on `TrackSchema`,
  // not on `KeyEventSchema`, which is why the GRID cannot show it and this
  // panel can. Absent means "nothing to say", never "it went fine", so the
  // block is omitted rather than rendered with an em-dash.
  const previewMiss = describePreviewMiss(track?.previewMissReason)
  const firstSeenValue = track
    ? formatFaceTimestampFull(track.firstSeen)
    : formatFaceTimestampFull(timestamp)
  const lastSeenValue = track ? formatFaceTimestampFull(track.lastSeen) : '—'
  // WHERE it was detected — node · device (model) of the frame that opened the
  // track and of the sighting that closed it; one row when they agree, none
  // when the row names no placement (unknown is not "the hub").
  const placementRows = trackPlacementRows(track)
  const placementLabel: Record<TrackPlacementRowKind, string> = {
    detected: t('detectionIntelligence.eventDetailPanel.detectedOn', 'Detected on'),
    opened: t('detectionIntelligence.eventDetailPanel.openedOn', 'Opened on'),
    closed: t('detectionIntelligence.eventDetailPanel.closedOn', 'Closed on'),
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        width="lg"
        placement="sheet-on-mobile"
        aria-label={t('detectionIntelligence.eventDetailPanel.eventDetail', 'Event detail')}
        className={
          // Mobile: a DEFINITE near-full height (`h-[92dvh]`), not just a
          // `max-h`. A native top-layer <dialog> in a flex column needs a
          // resolved height for the `flex-1 min-h-0` body to bound its
          // scroll area; with only `max-h` the body compresses on iOS Safari
          // (dvh + dialog quirk) and the media renders as a sliver with the
          // metadata/footer clipped. A fixed height makes the body scroll
          // deterministically, so the hero shows at a usable size and every
          // row is reachable. md+: revert to `h-auto` + `max-h` so the
          // desktop centered card is unchanged (grows to content, capped).
          'flex h-[92dvh] flex-col gap-0 overflow-hidden p-0 ' +
          'bottom-0 left-0 right-0 top-auto w-full max-w-full translate-x-0 translate-y-0 rounded-b-none ' +
          'md:bottom-auto md:left-1/2 md:right-auto md:top-1/2 md:h-auto md:w-[calc(100vw-2rem)] md:max-w-xl ' +
          'md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:max-h-[calc(100dvh-2rem)]'
        }
      >
        {/* Header — Close is the DialogContent built-in (pr-10 clears its hit area). */}
        <header className="flex shrink-0 items-start gap-2 border-b border-border py-3 pl-4 pr-10">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {row.className}
              {rowDisplayLabel(row) ? (
                <span className="text-foreground-subtle"> · {rowDisplayLabel(row)}</span>
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-foreground-subtle">{cameraName}</div>
          </div>
        </header>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
          {/* Hero */}
          {heroSrc ? (
            <div className="overflow-hidden rounded-lg border border-border bg-background">
              <ZoomableImage
                src={heroSrc}
                alt={t(
                  'detectionIntelligence.eventDetailPanel.keyFrameFrom',
                  'Key frame from {{cameraName}}',
                  { cameraName },
                )}
                fit="natural"
                className="w-full"
                overlay={
                  showTrajectory ? (
                    <TrajectorySvg overlay={overlay} onPickSnapshot={pickSnapshotFrame} />
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-surface-hover text-foreground-subtle">
              {hero.failed ? (
                <>
                  <ImageOff className="h-8 w-8 opacity-60" />
                  <span className="text-[11px]">
                    {t(
                      'detectionIntelligence.eventDetailPanel.keyFrameMediaUnavailable',
                      'Key-frame media unavailable',
                    )}
                  </span>
                </>
              ) : (
                <Loader2 className="h-6 w-6 animate-spin opacity-70" />
              )}
            </div>
          )}

          {/* Filmstrip — each frame labelled with WHAT it is + WHEN, plus
              copy-URL chips (LAN + public tunnel when available). */}
          {filmstrip.length > 0 && (
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {filmstrip.map((m) => {
                const label = mediaKindLabel(m.kind)
                const localUrl = buildMediaUrl(LOCAL_ORIGIN, m.url)
                const publicUrl = publicOrigin ? buildMediaUrl(publicOrigin, m.url) : null
                return (
                  <figure key={m.mediaId} className="flex w-32 shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => setHeroOverride(m)}
                      className="relative h-16 w-full overflow-hidden rounded border border-border hover:border-primary"
                      title={`${label} · ${formatFaceTimestampFull(m.timestamp)}`}
                    >
                      <FilmstripThumb url={m.url} label={label} />
                    </button>
                    <figcaption className="min-w-0 px-0.5">
                      <div
                        className="truncate text-[10px] font-medium leading-tight text-foreground"
                        title={label}
                      >
                        {label}
                      </div>
                      <div
                        className="text-[10px] leading-tight text-foreground-subtle"
                        title={formatFaceTimestampFull(m.timestamp)}
                      >
                        {formatClockTime(m.timestamp)}
                      </div>
                    </figcaption>
                    <CopyUrlChips localUrl={localUrl} publicUrl={publicUrl} />
                  </figure>
                )
              })}
            </div>
          )}

          {/* Invisible network-access probes that resolve the public origin. */}
          {publicOriginProbes}

          {/* Clip link */}
          {clip && (
            <Button variant="secondary" onClick={openClip} disabled={clipPending}>
              {clipPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Film className="h-3.5 w-3.5" />
              )}{' '}
              {t('detectionIntelligence.eventDetailPanel.viewClip', 'View clip')}
            </Button>
          )}

          {/* Per-track operator flags. Above the metadata block because they
              are the only WRITABLE thing on this panel besides delete, and a
              control buried under nine read-only rows is a control nobody
              finds. The flags read live off `track` (the full row) when it has
              loaded and fall back to the feed row while it has not. */}
          <TrackFlagToggles
            deviceId={row.deviceId}
            trackId={row.trackId}
            {...((track?.markForTrain ?? row.markForTrain) !== undefined
              ? { markForTrain: track?.markForTrain ?? row.markForTrain }
              : {})}
            {...((track?.debug ?? row.debug) !== undefined
              ? { debug: track?.debug ?? row.debug }
              : {})}
            {...((track?.favourited ?? row.favourited) !== undefined
              ? { favourited: track?.favourited ?? row.favourited }
              : {})}
            onChange={onFlagsChanged}
          />

          {/* Why the best shot is what it is (D276). Rendered ABOVE the
              metadata rows because it explains the picture the operator is
              looking at, which is the question they opened the panel with. */}
          {previewMiss !== null && (
            <div className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
                {t('detectionIntelligence.eventDetailPanel.bestShot', 'Best shot')}
              </p>
              <p className="mt-0.5 text-xs text-foreground">{previewMiss.sentence}</p>
              {/* The pipeline's own tokens, verbatim: this is the string an
                  operator greps the hub log for, and paraphrasing it away
                  would make the two impossible to correlate. */}
              <code className="mt-1 block break-all font-mono text-[10px] text-foreground-subtle">
                {previewMiss.raw}
              </code>
            </div>
          )}

          {/* Metadata */}
          <div className="rounded-lg border border-border bg-surface px-3 py-1">
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.camera', 'Camera')}
              value={cameraName}
            />
            {placementRows.map((r) => (
              <MetaRow key={r.kind} label={placementLabel[r.kind]} value={r.value} mono wrap />
            ))}
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.class', 'Class')}
              value={row.className}
            />
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.label', 'Label')}
              value={row.label ?? '—'}
            />
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.subLabel', 'Sub-label')}
              value={row.subLabel ?? '—'}
            />
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.importance', 'Importance')}
              value={importanceValue}
            />
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.zonesVisited', 'Zones visited')}
              value={zonesValue}
            />
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.audioHeard', 'Audio heard')}
              value={audioValue}
            />
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.totalDistance', 'Total distance')}
              value={distanceValue}
            />
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.firstSeen', 'First seen')}
              value={firstSeenValue}
            />
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.lastSeen', 'Last seen')}
              value={lastSeenValue}
            />
            <MetaRow
              label={t('detectionIntelligence.eventDetailPanel.track', 'Track')}
              value={row.trackId}
              mono
            />
          </div>
        </div>

        {/* Footer */}
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <span title={deleteAvailable ? undefined : DELETE_UNAVAILABLE_TITLE}>
            <Button
              variant="secondary"
              onClick={runDelete}
              disabled={!deleteAvailable || del.isPending}
            >
              {del.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}{' '}
              {t('detectionIntelligence.eventDetailPanel.deleteTrack', 'Delete track')}
            </Button>
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
