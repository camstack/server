import type { DecodedFrame, FrameHandle, IScopedLogger } from '@camstack/types'
import type { FrameBox } from '../../shared/frame/box-drawer.js'
import { drawBoxedFrame, drawBoxedJpeg } from '../../shared/frame/box-drawer.js'
import { bundledCamstack, paintHex } from '@camstack/types'

const BUNDLED_PALETTE = bundledCamstack()
import { extractCrop } from '../../shared/frame/crop-extractor.js'
import { MEDIA_QUALITY } from '../../shared/frame/media-quality.js'
import { resolveFrame } from '../../shared/frame/resolve-frame.js'
import { createSharedFrameResolver } from '../../shared/frame/shared-frame-resolver.js'
import type { NormalizedBbox } from '../../shared/frame/square-safe-crop.js'
import { squareSafeCropRegionNormalized } from '../../shared/frame/square-safe-crop.js'
import {
  composeWideCentralSquareThumbnail,
  deriveThumbnailSmall,
} from '../../shared/frame/subject-crop-variants.js'
import {
  deliveredWideCentralSquareLayout,
  type WideCentralSquareLayout,
} from '../../shared/frame/wide-central-square-crop.js'
import type { KeyFrameSelectionKind } from '../pipeline/key-frame-capture.js'
import { isUsableBbox } from '../pipeline/usable-bbox.js'
import type { MediaProvenance, MediaStore } from '../store/media-store.js'

/**
 * Long-side cap (px) for the boxed timeline tiles — `firstFrame`, `snapshot`,
 * `lastFrame`. These are the low-res "timeline filmstrip" images: a native full
 * frame downscaled to 960 with ONLY the track's own box burned in. A native miss
 * falls back to the ≤640 detection frame (an honest lower-res frame, NEVER an
 * upscale).
 */
const SNAPSHOT_MAX_WIDTH = 960

/** Bound the once-per-owner display-fallback memo so a long-lived process never
 *  leaks it. */
const MAX_LOGGED_DISPLAY_FALLBACKS = 5_000

/**
 * Both renderings of ONE decoded surface: the boxed timeline tile, and its
 * CLEAN twin (`sceneFrame`, D654) — same pixels, no box.
 */
interface SceneRenderings {
  readonly boxed: Buffer
  readonly clean: Buffer
}

/**
 * The media-store operations this dispatcher performs — structurally, so a
 * test can hand a typed fake instead of casting one to the whole class.
 */
export type EventMediaWriter = Pick<MediaStore, 'put' | 'putReplacing'>

/** One `pinned-frame resolve missed` line per device per minute. */
const PINNED_MISS_WARN_THROTTLE_MS = 60_000

/** A pixel-space bbox in the inference frame. */
export interface PixelBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** An object event needing media (crop + boxed thumbnail). */
export interface EventMediaTarget {
  readonly eventId: string
  readonly timestamp: number
  readonly bbox: PixelBox
  readonly className: string
  readonly confidence?: number
  /** Enriched label (identity / plate text); overrides the class caption. */
  readonly label?: string
  /**
   * Child detail crops to save alongside the parent event media.
   * Each entry is cropped from the SAME synchronously-held frame as the
   * parent event's `crop`/`thumbnail`/`fullFrame`/`fullFrameBoxed` writes.
   * Only kinds whose bbox is provided are written; absent kinds are skipped.
   */
  readonly childCrops?: ReadonlyArray<{
    readonly kind: 'faceCrop' | 'plateCrop'
    readonly bbox: PixelBox
  }>
}

/** A track needing a boxed first-frame canvas. */
export interface TrackFrameTarget {
  readonly trackId: string
  readonly timestamp: number
  readonly bbox: PixelBox
  readonly label?: string
  /** Detector class — the box is stroked in that palette colour. */
  readonly className?: string
}

/**
 * A track needing periodic media this frame (§5 snapshot cadence). Each flag
 * selects one write from the SAME resolved frame:
 *  - `appendSnapshot`  → append a `snapshot` (accumulating timeline filmstrip),
 *  - `rollingLastFrame`→ overwrite the single rolling `lastFrame`,
 *  - `bestThumbnail`   → overwrite the single best `thumbnail` (highest conf).
 * snapshot/lastFrame share ONE boxed full-frame encode; the thumbnail is a
 * separate clean subject-centered crop (the gallery/reel fallback tile).
 */
export interface TrackSnapshotTarget {
  readonly trackId: string
  readonly timestamp: number
  readonly bbox: PixelBox
  readonly label?: string
  /** Detector class — the box is stroked in that palette colour. */
  readonly className?: string
  readonly appendSnapshot: boolean
  readonly rollingLastFrame: boolean
  readonly bestThumbnail: boolean
  /** Which native-`keyFrame` path this frame chose for the track — a genuine
   *  new-best peak, the BOUNDED catch-up retry (2026-08-06), or neither.
   *  Consumed by `selectKeyFrameCaptures`, not by the dispatcher itself. */
  readonly keyFrame: KeyFrameSelectionKind
}

/** An appended `snapshot` that was persisted — the caller wires it onto the
 *  TrackStore (`addSnapshot`) so `Track.snapshots` references the media. */
export interface StoredSnapshot {
  readonly trackId: string
  /** Media id (D482) of the persisted snapshot row. */
  readonly mediaId: number
  readonly timestamp: number
  readonly bbox: PixelBox
}

/**
 * A confirmed track observed this frame that carries NO other media target — the
 * caller supplies its bbox so a zero-media raster fallback can still be cut for
 * it (widened retention: ANY confirmed track, not only those with a
 * firstFrame/snapshot target this frame). See {@link RasterFallbackCrop}.
 */
export interface RasterFallbackCandidate {
  readonly trackId: string
  readonly timestamp: number
  readonly bbox: PixelBox
}

/**
 * A retained detection-raster subject crop for the zero-media raster fallback
 * (spec §"Zero-media track policy"). Cut from the ≤native detection frame
 * (`frameData`, NEVER upscaled), it is RETURNED — not persisted — so the caller
 * retains the FIRST one per track and commits it as a `thumbnail` ONLY at close
 * when the track still has no media. This is why the fallback can never silently
 * degrade a native-capable track: it is a memo, not a write.
 */
export interface RasterFallbackCrop {
  readonly trackId: string
  readonly timestamp: number
  readonly jpeg: Buffer
}

export interface CaptureForFrameInput {
  readonly deviceId: number
  readonly frameHandle: FrameHandle
  readonly events: readonly EventMediaTarget[]
  readonly trackFrames: readonly TrackFrameTarget[]
  /** Periodic per-track snapshot / lastFrame / best-thumbnail writes (§5). */
  readonly snapshots?: readonly TrackSnapshotTarget[]
  /** Fractional padding applied to the detection bbox before cropping (0 = tight). */
  readonly cropPadding: number
  /**
   * Tracks that still have NO retained zero-media raster fallback. For any of
   * these that has a target this frame, ONE clean subject crop is cut from the
   * already-resolved detection raster (`frameData`) and RETURNED in
   * {@link CaptureForFrameResult.rasterFallbacks} — bounded to one per track per
   * frame. Omit / empty ⇒ no raster fallback work (back-compat).
   */
  readonly rasterFallbackWantedTrackIds?: ReadonlySet<string>
  /**
   * Extra bbox candidates for the zero-media raster fallback — confirmed tracks
   * observed this frame that carry NO firstFrame/snapshot target (so their bbox
   * is not otherwise available to {@link collectRasterFallbacks}). Merged AFTER
   * the target-derived candidates, so a track with a real target keeps that
   * target's bbox. Only used for ids that are ALSO in
   * {@link rasterFallbackWantedTrackIds}. Omit / empty ⇒ back-compat.
   */
  readonly rasterFallbackCandidates?: readonly RasterFallbackCandidate[]
  /**
   * The ≤640 detection frame pre-resolved (and COPIED) by the caller IN THE
   * LIVE frame window, BEFORE this batch was queued on the CaptureScheduler —
   * see {@link EventMediaDispatcher.resolvePinnedFrame}. When present the
   * by-handle resolve for the ≤640 tier is SKIPPED and this frame is used
   * directly, so a batch that starts seconds late (saturated device lane) no
   * longer loses every boxed tile to a recycled ring slot. The native
   * full-frame / subject-crop fetches keep their own by-handle path — their
   * ≤640 fallback then uses this pinned data wherever `frameData` is
   * referenced. Omit ⇒ legacy by-handle resolve (back-compat).
   */
  readonly pinnedFrame?: DecodedFrame
}

export interface CaptureForFrameResult {
  /** Appended `snapshot` entries the caller records on the TrackStore. */
  readonly storedSnapshots: readonly StoredSnapshot[]
  /** Track ids whose best `thumbnail` was ACTUALLY written this frame (#27-A).
   *  The caller stops forcing best-thumbnail retries for these tracks; a track
   *  absent here (e.g. the frame was recycled/blank so capture returned empty)
   *  keeps retrying on the next frame until a thumbnail lands. */
  readonly thumbnailTrackIds: readonly string[]
  /** Track ids whose `firstFrame` was ACTUALLY persisted this frame (DEFECT A).
   *  The `firstFrame` is captured once at birth, but the async encode can
   *  silently drop when the live frame lease is recycled before it runs, or the
   *  resolved frame is blank (hwaccel/cold-start) — and `captureForFrame` returns
   *  early (`empty`) on a recycled/blank frame, so the birth `firstFrame` is
   *  never written and there is NO retry. The caller keeps a per-track
   *  "not-yet-landed" set and re-schedules a `firstFrame` target on subsequent
   *  frames until the track appears here — the analog of the #27-A thumbnail
   *  retry. A track absent here keeps retrying. */
  readonly firstFrameTrackIds: readonly string[]
  /** Track ids whose rolling `lastFrame` was ACTUALLY overwritten this frame
   *  (DEFECT B). The caller advances its `lastFrameAt` clock ONLY for these
   *  tracks — a `rollingLastFrame` that dropped (recycled/blank frame, or a
   *  failed `putReplacing`) is absent, so the clock stays put and the roll
   *  retries on the next eligible non-snapshot frame. This is what makes the
   *  clock honour "the last ACTUALLY-written lastFrame" (the map's contract). */
  readonly lastFrameTrackIds: readonly string[]
  /** Detection-raster subject crops the caller RETAINS (first-per-track) for the
   *  zero-media raster fallback. Empty unless `rasterFallbackWantedTrackIds` was
   *  supplied and a resolved (non-blank) frame was in hand. */
  readonly rasterFallbacks: readonly RasterFallbackCrop[]
}

/**
 * The best-shot subject slab as the parcel client hands it over (D422): the
 * runner cut the 16:9 central-square window at the best instant; the hub kept
 * the layout beside it so the slab can be composed onto its canvas here.
 */
export interface ParkedSubjectSlab {
  readonly slab: Buffer
  readonly layout: WideCentralSquareLayout
  /** The frame instant the slab shows — what the media rows are stamped with. */
  readonly timestamp: number
}

export interface EventMediaDispatcherDeps {
  /**
   * The track's PARKED best-shot slab, by `(deviceId, trackId)` — the ONLY
   * source of the `thumbnail` / `thumbnailSmall` pair. `null` = no parcel
   * (the park was refused at the best instant, or the node let it go); the
   * write is skipped and the per-frame retry parks a later frame. NEVER
   * substituted with a by-handle crop — a retrieval keyed by a track does
   * not reach back for pixels (D422).
   */
  readonly getParkedSubjectSlab: (
    deviceId: number,
    trackId: string,
  ) => Promise<ParkedSubjectSlab | null>
  /**
   * Full-frame fetch by handle, routed to the owning runner
   * (`pipelineRunner.getNativeCrop` full-frame). No shm read (2026-07-16).
   */
  readonly getRemoteFrame: (handle: FrameHandle) => Promise<DecodedFrame | null>
  /**
   * NATIVE-resolution subject-crop fetch, routed to the owning runner
   * (`pipelineRunner.getNativeCrop`, the decode worker's retained native
   * surface). Given the square-safe region in NORMALIZED [0,1] coords and an
   * OPTIONAL `maxWidth` cap (OMITTED here → uncapped, the crop at TRUE native
   * resolution, decision #3), returns an encoded JPEG of that ROI, or `null` on
   * any miss/error. A `null` is NEVER upscaled: the caller SKIPS the write and
   * logs — the per-frame retry lands a real native crop later. Absent
   * (undefined) on a runner without the method (version skew) → the crop is
   * likewise skipped (never an upscaled blurred tile).
   */
  readonly getNativeCropJpeg?: (
    handle: FrameHandle,
    normalizedBbox: NormalizedBbox,
    maxWidth?: number,
    /** Only for the transport's refusal log `tags` — a sub-native refusal RATE
     *  is asked per camera. */
    deviceId?: number,
  ) => Promise<Buffer | null>
  /**
   * Full NATIVE frame by handle, downscaled worker-side to `<= maxWidth` long
   * side, returned as raw rgb (`DecodedFrame`). `maxWidth:960` → ~1.5 MB. Used to
   * cut the boxed timeline tiles (`firstFrame`/`snapshot`/`lastFrame`) from the
   * SAME native surface the subject crops use. Returns `null` on any miss/error
   * (or a runner without the method) → the caller falls back to the ≤640
   * detection frame (honest lower res, never an upscale) with a `logger.warn`.
   */
  readonly getNativeFullFrameRgb: (
    handle: FrameHandle,
    maxWidth: number,
  ) => Promise<DecodedFrame | null>
  /**
   * The same full frame in its wire JPEG form. When present the boxed timeline
   * tiles are drawn and encoded in ONE libvips pipeline from it
   * (`drawBoxedJpeg`) — no RGB surface in this process (D867). Absent only on
   * test doubles, which keep the RGB path.
   */
  readonly getNativeFullFrameJpeg?: (
    handle: FrameHandle,
    maxWidth: number,
  ) => Promise<NativeFullFrameJpeg | null>
  readonly mediaStore: EventMediaWriter
  readonly logger: IScopedLogger
  /**
   * Class → palette hex. Absent in tests: the bundled CamStack preset.
   * A live painter refreshes from `display-palette` and, when that read is
   * unknown, keeps painting the bundled preset (D939).
   */
  readonly paintClass?: (kind: string) => string
  /**
   * Fired once per best-`thumbnail` MISS, with the reason the warn line
   * already names (`parcel-missing` / `threw`). The residents accumulate it so
   * a close without a tile can say WHY (D276/B2).
   */
  readonly onSubjectCropMiss?: (deviceId: number, trackId: string, reason: string) => void
}

/** A full frame as the owning runner encoded it, plus the raster's dimensions. */
export interface NativeFullFrameJpeg {
  readonly jpeg: Buffer
  readonly width: number
  readonly height: number
}

/**
 * Map a detection-frame pixel box (`fromW`×`fromH`, the ≤640 raster the tracker
 * ran on) onto the native full frame (`toW`×`toH`, the 960-downscaled native
 * surface). Both frames show the SAME scene at the same aspect ratio, so a
 * uniform per-axis scale places the box correctly on the higher-res frame.
 */
function scaleBox(
  bbox: PixelBox,
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
  label?: string,
): FrameBox {
  const sx = toW / fromW
  const sy = toH / fromH
  return {
    x: bbox.x * sx,
    y: bbox.y * sy,
    w: bbox.w * sx,
    h: bbox.h * sy,
    ...(label ? { label } : {}),
  }
}

/**
 * True when a packed-RGB frame is (near-)uniform in every channel — the
 * signature of a blank / hwaccel-unmapped decode frame. Samples a strided set
 * of pixels and checks each channel's min→max spread stays within a small
 * epsilon; a real image always has spread in at least one channel. Cheap
 * (~512 samples) so it runs on every capture.
 */
function isUniformRgbFrame(data: Buffer, width: number, height: number): boolean {
  const pixels = width * height
  if (pixels === 0 || data.length < pixels * 3) return false
  const step = Math.max(1, Math.floor(pixels / 512)) * 3
  const mins = [255, 255, 255]
  const maxs = [0, 0, 0]
  for (let i = 0; i + 2 < data.length; i += step) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c]!
      mins[c] = Math.min(mins[c]!, v)
      maxs[c] = Math.max(maxs[c]!, v)
    }
  }
  return maxs.every((mx, c) => mx - mins[c]! <= 6)
}

/**
 * Generates object-event + track media FROM the decoded detection-pipeline
 * frame (the `frameHandle`/native surface the detector ran on), NEVER the device
 * snapshot cap.
 *
 * Per object event it writes ONLY the enrichment child crops
 * (`faceCrop`/`plateCrop`) — the retired `crop`/`fullFrame`/`fullFrameBoxed`
 * kinds are no longer produced (2026-07-21; old stored tracks keep reading them,
 * the enum is unchanged). The representative event image is now the track
 * `thumbnail`/`keyFrame`.
 *
 * Per track it writes the boxed timeline tiles — a `firstFrame` on track start,
 * plus periodic `snapshot`/`lastFrame` — each cut from the runner's NATIVE full
 * frame downscaled to {@link SNAPSHOT_MAX_WIDTH} (960) with ONLY the track's own
 * box burned in, falling back to the ≤640 detection frame (honest lower res,
 * never an upscale) on a native miss. The best `thumbnail` stays a clean,
 * uncapped native subject crop — read from the track's PARKED slab, by track
 * (D422), never by handle.
 *
 * The detection frame is resolved ONCE per call (blank-frame guard); native full
 * frames + subject crops are fetched per target by handle. Frames recycle in
 * milliseconds, so the caller either invokes this while the handle is still
 * live, or — when the call is queued behind a capture lane (the S3 batch
 * dispatch) — pre-resolves the ≤640 frame in the live window via
 * {@link resolvePinnedFrame} and passes it as `pinnedFrame`, which skips the
 * by-handle resolve for the ≤640 tier entirely.
 */
export class EventMediaDispatcher {
  /**
   * Per-frame single-slot memo of the native 960 full frame (S3): every track
   * tile in ONE `captureForFrame` pass shares the SAME `frameHandle`, so multiple
   * `boxedTimelineFrame` calls would otherwise each round-trip the runner for the
   * identical native full frame. Keyed by frame identity (`createSharedFrameResolver`)
   * so a recycled slot (new `seq`) is a fresh fetch. `maxWidth` is always
   * {@link SNAPSHOT_MAX_WIDTH} here (the only dispatcher use of the fetch).
   */
  private readonly sharedNativeFullFrame: (handle: FrameHandle) => Promise<DecodedFrame | null>

  /** The JPEG twin of {@link sharedNativeFullFrame} — the boxed tiles' source
   *  (a few tens of kB held instead of a 1.5 MB RGB surface). */
  private readonly sharedNativeFullJpeg: (
    handle: FrameHandle,
  ) => Promise<NativeFullFrameJpeg | null>

  /** Once-per-owner (`${eventId}:${kind}`) memo for the DISPLAY-crop fallback
   *  info log — see {@link logDisplayFallbackOnce}. */
  private readonly loggedDisplayFallbacks = new Set<string>()

  /** Per-device throttle for {@link warnPinnedFrameMiss}. */
  private readonly lastPinnedMissWarnAt = new Map<number, number>()

  constructor(private readonly deps: EventMediaDispatcherDeps) {
    this.sharedNativeFullFrame = createSharedFrameResolver((handle) =>
      this.deps.getNativeFullFrameRgb(handle, SNAPSHOT_MAX_WIDTH),
    )
    this.sharedNativeFullJpeg = createSharedFrameResolver(async (handle) =>
      this.deps.getNativeFullFrameJpeg
        ? this.deps.getNativeFullFrameJpeg(handle, SNAPSHOT_MAX_WIDTH)
        : null,
    )
  }

  /**
   * Resolve the ≤640 detection frame by handle NOW — in the caller's LIVE frame
   * window — and hold the privately owned pixel buffer the fetch returned (no
   * copy — D867), so ring recycling can never touch it. This is the seam the per-frame batch dispatch uses to pin the
   * frame BEFORE queueing on the CaptureScheduler: since S3 the batch is one
   * scheduler request against a 3-slot device lane and can start seconds late,
   * by which time the handle's ring slot is usually recycled and the by-handle
   * resolve in {@link captureForFrame} finds nothing (the 2026-07-23 boxed-tile
   * regression). ~0.7MB per pinned frame, freed with the batch.
   *
   * THE COPY IS ONLY AS BOUNDED AS THE QUEUE THAT HOLDS IT. This said "bounded
   * by the lane" while the lane bounded in-flight execs (3) and nothing at all
   * bounded the queue behind them, so a saturated camera accumulated pinned
   * frames without limit — 2.28 GB of `arrayBuffers` measured on the live hub.
   * Every caller must therefore pass `staleAfterMs`, and `CaptureScheduler`
   * caps queue depth per device. Returns `null` on a genuine live-window miss.
   *
   * Both miss paths are WARN, throttled to one line per device per minute. They
   * are the FIRST half of a pair whose second half (`capture batch lost`) has
   * always been a warn: a batch that lost its frame is reported with
   * `pinned: false`, and until 2026-08-07 the reason the pin itself failed was
   * either at debug (the throw) or nowhere at all (the null return). 383 batch
   * losses in 3 h had `pinned: false` on 100% of them and nothing said why.
   */
  async resolvePinnedFrame(
    deviceId: number,
    frameHandle: FrameHandle,
  ): Promise<DecodedFrame | null> {
    try {
      const decoded = await resolveFrame(frameHandle, {
        getRemoteFrame: this.deps.getRemoteFrame,
      })
      if (!decoded) {
        this.warnPinnedFrameMiss(deviceId, frameHandle, 'recycled-before-pin')
        return null
      }
      // NOT copied (D867). `decoded.data` is private: `getRemoteFrame` is the
      // transport's full-frame fetch and `cropReplyToRgb` allocates this buffer
      // per call (sharp's `toBuffer`, or a one-off copy of the reply's `bytes`).
      // No ring slot or shared scratch backs it any more, and every consumer
      // below only READS it. The copy that was here duplicated a ≤640 RGB
      // surface per captured frame.
      return decoded
    } catch (err) {
      this.warnPinnedFrameMiss(deviceId, frameHandle, 'threw', String(err))
      return null
    }
  }

  /** One `pinned-frame resolve missed` line per device per minute. Throttled
   *  because it fires per capture batch, and the batch's own loss line is not. */
  private warnPinnedFrameMiss(
    deviceId: number,
    frameHandle: FrameHandle,
    reason: 'recycled-before-pin' | 'threw',
    error?: string,
  ): void {
    const now = Date.now()
    const last = this.lastPinnedMissWarnAt.get(deviceId) ?? 0
    if (now - last < PINNED_MISS_WARN_THROTTLE_MS) return
    this.lastPinnedMissWarnAt.set(deviceId, now)
    this.deps.logger.warn('event media: pinned-frame resolve missed (live window)', {
      tags: { deviceId },
      meta: {
        reason,
        shmId: frameHandle.shmId,
        handle: `${frameHandle.shmId}#${frameHandle.slot}#${frameHandle.seq}`,
        handleNodeId: frameHandle.nodeId,
        ...(error !== undefined ? { error } : {}),
      },
    })
  }

  /**
   * WARN-log a whole-batch capture abort: every early return in
   * {@link captureForFrame} loses ALL of the frame's targets at once —
   * firstFrame + snapshot/lastFrame/thumbnail + event child crops — which
   * previously died with DEBUG-only logs (invisible in production, the silent
   * half of the boxed-tile regression). The per-kind lost-target counts make
   * the blast radius visible.
   */
  private warnBatchLost(
    reason: string,
    input: CaptureForFrameInput,
    extraMeta: Record<string, unknown> = {},
  ): void {
    this.deps.logger.warn(`event media: capture batch lost — ${reason}`, {
      tags: { deviceId: input.deviceId },
      meta: {
        deviceId: input.deviceId,
        shmId: input.frameHandle.shmId,
        pinned: input.pinnedFrame !== undefined,
        lostEventTargets: input.events.length,
        lostFirstFrameTargets: input.trackFrames.length,
        lostSnapshotTargets: input.snapshots?.length ?? 0,
        ...extraMeta,
      },
    })
  }

  async captureForFrame(input: CaptureForFrameInput): Promise<CaptureForFrameResult> {
    const { deviceId, frameHandle, events, trackFrames } = input
    const snapshots = input.snapshots ?? []
    const empty: CaptureForFrameResult = {
      storedSnapshots: [],
      thumbnailTrackIds: [],
      firstFrameTrackIds: [],
      lastFrameTrackIds: [],
      rasterFallbacks: [],
    }
    // Nothing to do only when there is NO work of any kind — including the
    // widened zero-media raster-fallback candidates (FIX B), which resolve the
    // frame purely to retain a last-resort crop for a confirmed track that has no
    // other target this frame.
    const extraCandidateCount = input.rasterFallbackCandidates?.length ?? 0
    if (
      events.length === 0 &&
      trackFrames.length === 0 &&
      snapshots.length === 0 &&
      extraCandidateCount === 0
    ) {
      return empty
    }

    // The ≤640 detection frame: the caller-pinned copy when present (resolved
    // in the LIVE window before the batch was queued — `resolvePinnedFrame`),
    // otherwise the legacy by-handle resolve. Every abort below loses the WHOLE
    // batch at once (firstFrame + snapshot/lastFrame/thumbnail + event child
    // crops die together), so each logs at WARN with per-kind lost-target
    // counts (`warnBatchLost`) — never DEBUG-silent.
    let decoded: DecodedFrame | null
    if (input.pinnedFrame !== undefined) {
      decoded = input.pinnedFrame
    } else {
      try {
        decoded = await resolveFrame(frameHandle, {
          getRemoteFrame: this.deps.getRemoteFrame,
        })
      } catch (err) {
        this.warnBatchLost('resolveFrame threw', input, { error: String(err) })
        return empty
      }
    }

    if (!decoded) {
      this.warnBatchLost('frame recycled before resolve', input)
      return empty
    }
    if (decoded.format !== 'rgb') {
      this.warnBatchLost('resolved frame is not RGB', input, {
        format: decoded.format,
      })
      return empty
    }

    // Copy out of the reader's BORROWED scratch buffer immediately: `decoded.data`
    // aliases a shared shm-ring scratch slot (FrameRead contract) that a concurrent
    // same-shmId read() can overwrite while we `await` the sharp / box-draw encodes
    // below — copying once prevents torn / other-frame crops. A pinned frame was
    // already copied at pin time (live window) and is exclusively owned — no
    // second copy needed.
    const frameData = decoded.data
    const fw = decoded.width
    const fh = decoded.height

    // Reject a uniform / blank resolved frame. The decoder intermittently commits
    // a solid gray/green frame (unmapped hwaccel surface / cold-start), and the
    // tracker's coasting emits events on such non-detection frames; cropping one
    // yields a solid ~1.6KB "black" thumbnail. Skip so the event carries no
    // misleading media rather than a fake solid frame. (Decode-side root cause
    // tracked separately.)
    if (isUniformRgbFrame(frameData, fw, fh)) {
      this.warnBatchLost('resolved frame uniform (blank/hwaccel)', input, {
        width: fw,
        height: fh,
      })
      return empty
    }

    // Zero-media raster fallback (spec §"Zero-media track policy"): while the
    // frame is resolved and non-blank, cut ONE clean subject crop from the
    // detection raster for each WANTED track that has a target this frame. It is
    // RETAINED by the caller and committed only at close if the track is still
    // media-less — so it never degrades a native-capable track. Done BEFORE the
    // native writes so the retention lands even if a native fetch throws.
    const rasterFallbacks = await this.collectRasterFallbacks(
      frameData,
      fw,
      fh,
      trackFrames,
      snapshots,
      input.rasterFallbackWantedTrackIds,
      input.rasterFallbackCandidates,
    )

    for (const ev of events) {
      await this.writeEventMedia(deviceId, frameHandle, frameData, fw, fh, ev, input.cropPadding)
    }
    const firstFrameTrackIds: string[] = []
    for (const tf of trackFrames) {
      const landed = await this.writeTrackFrame(deviceId, frameHandle, frameData, fw, fh, tf)
      if (landed) firstFrameTrackIds.push(tf.trackId)
    }
    const storedSnapshots: StoredSnapshot[] = []
    const thumbnailTrackIds: string[] = []
    const lastFrameTrackIds: string[] = []
    for (const sn of snapshots) {
      const res = await this.writeTrackSnapshot(deviceId, frameHandle, frameData, fw, fh, sn)
      if (res.storedSnapshot) storedSnapshots.push(res.storedSnapshot)
      if (res.thumbnailWritten) thumbnailTrackIds.push(sn.trackId)
      if (res.lastFrameWritten) lastFrameTrackIds.push(sn.trackId)
    }
    return {
      storedSnapshots,
      thumbnailTrackIds,
      firstFrameTrackIds,
      lastFrameTrackIds,
      rasterFallbacks,
    }
  }

  /**
   * Cut ONE clean detection-raster subject crop per WANTED track observed this
   * frame — the "first available detection-raster frame" of the zero-media
   * fallback. Candidate bboxes come from this frame's firstFrame/snapshot targets
   * AND (widened) the explicit `extraCandidates` (confirmed tracks with no such
   * target). Cropped from the already-resolved `frameData` at its REAL resolution
   * via {@link extractCrop} (extract-only — NEVER upscaled). Deduped per trackId
   * (first candidate wins; target-derived candidates precede the extras). A
   * per-track encode failure is skipped (logged) — a missing fallback simply
   * leaves the track with no last-resort preview, never an error.
   */
  private async collectRasterFallbacks(
    frameData: Buffer,
    fw: number,
    fh: number,
    trackFrames: readonly TrackFrameTarget[],
    snapshots: readonly TrackSnapshotTarget[],
    wanted: ReadonlySet<string> | undefined,
    extraCandidates: readonly RasterFallbackCandidate[] | undefined,
  ): Promise<readonly RasterFallbackCrop[]> {
    if (!wanted || wanted.size === 0) return []
    const seen = new Set<string>()
    const out: RasterFallbackCrop[] = []
    const candidates: ReadonlyArray<{
      trackId: string
      timestamp: number
      bbox: PixelBox
    }> = [
      ...trackFrames.map((t) => ({
        trackId: t.trackId,
        timestamp: t.timestamp,
        bbox: t.bbox,
      })),
      ...snapshots.map((s) => ({
        trackId: s.trackId,
        timestamp: s.timestamp,
        bbox: s.bbox,
      })),
      ...(extraCandidates ?? []).map((c) => ({
        trackId: c.trackId,
        timestamp: c.timestamp,
        bbox: c.bbox,
      })),
    ]
    for (const c of candidates) {
      if (!wanted.has(c.trackId) || seen.has(c.trackId)) continue
      seen.add(c.trackId)
      try {
        // SAME GEOMETRY AS THE REAL THUMBNAIL, from the same function — never a
        // second copy of the framing rule. The fallback used to cut a
        // `squareSafeCropRegionNormalized` region (long side, 16:9 around a
        // square safe centre) while the best shot cut a `wideCentralSquareLayout`
        // window (central square = long side x1.2, slid in-frame), so the same
        // track looked like two different subjects depending on which path had
        // produced its preview. `cropPadding` is deliberately NOT applied: the
        // layout owns its own expansion (`SQUARE_SUBJECT_CROP_EXPANSION`), and
        // adding a second one here is exactly how the two drifted apart.
        const layout = deliveredWideCentralSquareLayout(c.bbox, { W: fw, H: fh })
        const { crop } = await extractCrop(frameData, fw, fh, layout.fetch)
        // Compose onto the full 16:9 canvas, as the native path does — a no-op
        // whenever the window is fully in frame, which after the slide it
        // almost always is.
        const jpeg = await composeWideCentralSquareThumbnail(crop, layout)
        out.push({ trackId: c.trackId, timestamp: c.timestamp, jpeg })
      } catch (err) {
        this.deps.logger.debug('event media: raster fallback crop failed', {
          meta: {
            trackId: c.trackId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    return out
  }

  /**
   * Periodic per-track media (§5). The boxed FULL frame is encoded once and
   * shared by the appended `snapshot` (timeline filmstrip) and the rolling
   * `lastFrame` (overwrite). The best `thumbnail` is DIFFERENT: a clean
   * subject-centered crop (same output contract as the object-event `crop`
   * kind) — it is the gallery/reel fallback for tracks that never produced an
   * object event, and a full frame there shows the scene (e.g. a foreground
   * parked car), not the track's subject. Returns the appended snapshot for
   * TrackStore wiring (null when `appendSnapshot` is false or the encode
   * failed). `thumbnailWritten` reports whether a best `thumbnail` actually
   * landed this frame (#27-A) so the caller can stop forcing retries.
   * `lastFrameWritten` reports whether the rolling `lastFrame` actually landed
   * (DEFECT B) so the caller advances its `lastFrameAt` clock ONLY on a real
   * write — a dropped roll leaves the clock put and retries next frame.
   */
  private async writeTrackSnapshot(
    deviceId: number,
    frameHandle: FrameHandle,
    frameData: Buffer,
    fw: number,
    fh: number,
    sn: TrackSnapshotTarget,
  ): Promise<{
    storedSnapshot: StoredSnapshot | null
    thumbnailWritten: boolean
    lastFrameWritten: boolean
  }> {
    if (!sn.appendSnapshot && !sn.rollingLastFrame && !sn.bestThumbnail) {
      return {
        storedSnapshot: null,
        thumbnailWritten: false,
        lastFrameWritten: false,
      }
    }

    // The boxed timeline tile — native 960 with the track's own box (fallback to
    // the ≤640 detection frame). Encoded ONCE and shared by `snapshot` +
    // `lastFrame`; `planPeriodicMedia` guarantees they are never both requested
    // for the same frame, so the single native fetch covers whichever fired.
    let scene: SceneRenderings | null = null
    if (sn.appendSnapshot || sn.rollingLastFrame) {
      scene = await this.boxedTimelineFrame(
        deviceId,
        frameHandle,
        frameData,
        fw,
        fh,
        sn.trackId,
        sn.bbox,
        sn.label,
        sn.className,
      )
    }

    let stored: StoredSnapshot | null = null
    if (sn.appendSnapshot && scene) {
      await this.writeSceneTwin(deviceId, sn.trackId, sn.timestamp, scene.clean, 'append')
      try {
        const mediaId = await this.deps.mediaStore.put({
          deviceId,
          ownerKind: 'track',
          ownerId: sn.trackId,
          kind: 'snapshot',
          timestamp: sn.timestamp,
          data: scene.boxed,
        })
        stored = {
          trackId: sn.trackId,
          mediaId,
          timestamp: sn.timestamp,
          bbox: sn.bbox,
        }
      } catch {
        /* put already logs; snapshot wiring skipped */
      }
    }
    let lastFrameWritten = false
    if (sn.rollingLastFrame && scene) {
      await this.writeSceneTwin(deviceId, sn.trackId, sn.timestamp, scene.clean, 'rolling')
      lastFrameWritten = await this.replaceKind(
        deviceId,
        sn.trackId,
        'lastFrame',
        sn.timestamp,
        scene.boxed,
      )
    }
    let thumbnailWritten = false
    if (sn.bestThumbnail) {
      // The PARKED slab or NOTHING (D422): a missing parcel returns null
      // (already logged by `cropSubjectVariants`) and leaves
      // `thumbnailWritten=false` so the caller retries on the next frame. We
      // NEVER degrade to the boxed full frame — a scene-dominated stand-in is
      // not the track's subject. ONE read backs both variants: the uncapped
      // native `thumbnail` and the 480 fast-load `thumbnailSmall` derived from
      // the SAME slab (best-crop fast-load).
      const variants = await this.cropSubjectVariants(deviceId, sn.trackId)
      if (variants) {
        // Provenance `native` (D276): this slab was cut from the runner's
        // NATIVE surface at the best instant — the terminal rank no stand-in
        // upgrade may ever overwrite. Stamped with the instant the slab SHOWS,
        // which on a retry is earlier than this frame.
        thumbnailWritten = await this.replaceKind(
          deviceId,
          sn.trackId,
          'thumbnail',
          variants.timestamp,
          variants.thumbnail,
          'native',
        )
        // The small variant tracks the same best-shot instant; a failed write
        // does not gate `thumbnailWritten` (the native `thumbnail` is the source
        // of truth) but is logged by `replaceKind`.
        await this.replaceKind(
          deviceId,
          sn.trackId,
          'thumbnailSmall',
          variants.timestamp,
          variants.thumbnailSmall,
          'native',
        )
      }
    }
    return { storedSnapshot: stored, thumbnailWritten, lastFrameWritten }
  }

  /**
   * Clean subject-centered crop of `bbox` for the DISPLAY child media
   * (`faceCrop`/`plateCrop`): the square-safe 16:9 region around the bbox with NO
   * box drawn.
   *
   * These are operator gallery images, NOT model inputs (the spec's native-source
   * hard rule governs model inputs, which stay native-strict). So a native-ROI
   * miss degrades gracefully — always honest, NEVER upscaled:
   *   1. native ROI crop (the runner's retained native surface) — best quality;
   *   2. the retained full frame (keyframe-native or the runner's ≤640 RAM tier)
   *      cropped to the SAME region;
   *   3. the already-resolved ≤640 detection raster (`frameData`, in hand) cropped
   *      to the region — the last-resort honest sub-native preview.
   * Only a total miss (all three unavailable) returns `null`. A fallback is
   * logged ONCE per owner (`${eventId}:${kind}`) at info level. Runs inside the
   * live-handle window opened by `captureForFrame`.
   */
  private async cropSubjectRegion(
    deviceId: number,
    frameHandle: FrameHandle,
    frameData: Buffer,
    fw: number,
    fh: number,
    bbox: PixelBox,
    cropPadding: number,
    ownerId: string,
  ): Promise<Buffer | null> {
    const norm = squareSafeCropRegionNormalized(bbox, { W: fw, H: fh }, cropPadding)
    // 1. Native ROI crop — the preferred, full-quality path.
    if (this.deps.getNativeCropJpeg) {
      try {
        const native = await this.deps.getNativeCropJpeg(frameHandle, norm, undefined, deviceId)
        if (native) return native
      } catch (err) {
        this.deps.logger.debug('display child crop: native ROI fetch threw', {
          meta: {
            shmId: frameHandle.shmId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    // 2. Retained full frame (keyframe-native or the runner's ≤640 RAM tier) →
    //    crop the SAME region locally. Honest, never upscaled.
    try {
      const full = await this.sharedNativeFullFrame(frameHandle)
      if (full && full.format === 'rgb' && full.width > 0 && full.height > 0) {
        const { crop } = await extractCrop(full.data, full.width, full.height, norm)
        this.logDisplayFallbackOnce(ownerId, 'native-full-frame')
        return crop
      }
    } catch (err) {
      this.deps.logger.debug('display child crop: full-frame fallback threw', {
        meta: {
          shmId: frameHandle.shmId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
    // 3. Last resort: the already-resolved ≤640 detection raster in hand.
    try {
      const { crop } = await extractCrop(frameData, fw, fh, norm)
      this.logDisplayFallbackOnce(ownerId, 'detection-raster')
      return crop
    } catch (err) {
      this.deps.logger.warn('display child crop: all sources missed', {
        meta: {
          shmId: frameHandle.shmId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return null
    }
  }

  /** Info-log a DISPLAY-crop fallback ONCE per owner (`${eventId}:${kind}`) so a
   *  short native window is visible without flooding the log every frame. */
  private logDisplayFallbackOnce(ownerId: string, reason: string): void {
    if (this.loggedDisplayFallbacks.has(ownerId)) return
    if (this.loggedDisplayFallbacks.size >= MAX_LOGGED_DISPLAY_FALLBACKS) {
      this.loggedDisplayFallbacks.clear()
    }
    this.loggedDisplayFallbacks.add(ownerId)
    this.deps.logger.info('display child crop fallback used (honest sub-native, not upscaled)', {
      meta: { ownerId, reason },
    })
  }

  /**
   * The best-shot subject crop as its TWO persisted variants (best-crop
   * fast-load, 2026-07-21; 16:9 central-square reframe, 2026-07-22), from the
   * track's PARKED slab (D422). ONE read, by `(deviceId, trackId)`: the
   * in-frame slab of the 16:9 central-square WINDOW
   * ({@link wideCentralSquareLayout}) the runner cut at uncapped native
   * resolution the instant the track's best was decided. It is composed into
   * the full 16:9 window (lateral letterbox only for the part outside the
   * frame) → the `thumbnail`. The `thumbnailSmall` is DERIVED by downscaling
   * that SAME window to the 480 long-side cap — never a second read, never
   * upscaled ({@link deriveThumbnailSmall} never upscales a smaller window).
   *
   * Both variants share the SAME framing + central-square containment
   * guarantee: wide consumers use the 16:9 image as-is; square consumers
   * center-crop the middle square (subject always inside it).
   *
   * PARCEL-OR-NOTHING: no parcel (or a throw) returns `null` after a loud
   * `logger.warn`; the caller SKIPS the write and the per-frame retry parks a
   * later frame. Never a by-handle crop, never a local upscale of a ≤640 tile.
   */
  private async cropSubjectVariants(
    deviceId: number,
    trackId: string,
  ): Promise<{ thumbnail: Buffer; thumbnailSmall: Buffer; timestamp: number } | null> {
    try {
      const parked = await this.deps.getParkedSubjectSlab(deviceId, trackId)
      if (!parked) {
        // The park's own refusal line (per camera, with the handle's age)
        // already said WHY there is no parcel; this is the write it cost.
        this.deps.logger.warn('best-shot parcel missing — no thumbnail this frame, will retry', {
          tags: { deviceId },
          meta: { trackId, reason: 'parcel-missing' },
        })
        this.deps.onSubjectCropMiss?.(deviceId, trackId, 'parcel-missing')
        return null
      }
      // Compose the native uncapped 16:9 window (subject in the central square);
      // the small variant is the SAME window downscaled to 480 long side.
      const thumbnail = await composeWideCentralSquareThumbnail(parked.slab, parked.layout)
      const thumbnailSmall = await deriveThumbnailSmall(thumbnail)
      return { thumbnail, thumbnailSmall, timestamp: parked.timestamp }
    } catch (err) {
      this.deps.logger.warn('best-shot parcel read failed — no thumbnail this frame, will retry', {
        tags: { deviceId },
        meta: {
          trackId,
          reason: 'threw',
          error: err instanceof Error ? err.message : String(err),
        },
      })
      this.deps.onSubjectCropMiss?.(deviceId, trackId, 'threw')
      return null
    }
  }

  /**
   * The CLEAN twin of a boxed timeline tile (D654), at the tile's own instant.
   *
   * WHY: a notification rule asking for "Full frame" (`frame: 'full'`) must be
   * handed the scene with no box, and the tiles were the only densely-written
   * whole-scene kind: 19 of 38 sampled `frame:'full'` deliveries shipped the
   * rectangle, and removing them from the ladder took the picture away from
   * 46.7% instead (see `ANNOTATED_SCENE_KINDS` in the notification centre).
   *
   * `append` mirrors an appended tile (`firstFrame`, `snapshot`) with an
   * accumulating `sceneFrame` row. `rolling` mirrors the rolling `lastFrame`
   * with the SINGLE-INSTANCE `lastSceneFrame`: its row id and blob path are
   * deterministic, so a roll is one blob overwrite plus one upsert — no read,
   * no delete (a roll fires every 2 s per live track, and every extra op lands
   * on the synchronous `sqlite-settings` thread, D447).
   *
   * Called BEFORE the tile's own write, so no reader can see the boxed tile of
   * an instant whose clean twin is not stored yet — the doorstep still-poll
   * would otherwise ship the box. Never gates the tile: a failed twin is logged
   * per camera and the tile's own write (and its landed-reporting) proceeds
   * exactly as before.
   */
  private async writeSceneTwin(
    deviceId: number,
    trackId: string,
    timestamp: number,
    clean: Buffer,
    role: 'append' | 'rolling',
  ): Promise<void> {
    try {
      await this.deps.mediaStore.put({
        deviceId,
        ownerKind: 'track',
        ownerId: trackId,
        kind: role === 'rolling' ? 'lastSceneFrame' : 'sceneFrame',
        timestamp,
        data: clean,
      })
    } catch (err) {
      this.deps.logger.warn(
        'event media: clean scene twin write failed — full-frame asks fall back',
        {
          tags: { deviceId },
          meta: {
            trackId,
            role,
            consequence:
              'a full-frame notification at this instant can only get the annotated tile',
            error: err instanceof Error ? err.message : String(err),
          },
        },
      )
    }
  }

  /**
   * The boxed timeline tile (`firstFrame`/`snapshot`/`lastFrame`): the track's
   * OWN box burned onto the NATIVE full frame downscaled to
   * {@link SNAPSHOT_MAX_WIDTH}. On a native miss it falls back to the ≤640
   * detection frame (`frameData`) downscaled to the same cap with a `logger.warn`
   * — an honest LOWER-res frame, NEVER an upscale.
   *
   * Returns BOTH renderings of the same surface: the boxed tile the timeline
   * wants, and its CLEAN twin (`drawBoxedFrame(…, [])` — encode only, the same
   * call `keyFrame` uses) for {@link writeSceneTwin}. One extra encode, no
   * second fetch and no second decode (D654). `null` only if a sharp encode
   * throws.
   */
  /** Stroke a timeline box in the class's palette colour. No class keeps the drawer's default. */
  private paletteBox(box: FrameBox, className: string | undefined): FrameBox {
    if (className === undefined || className.length === 0) return box
    const paint = this.deps.paintClass
    const color =
      paint !== undefined
        ? paint(className)
        : paintHex(BUNDLED_PALETTE.swatches, BUNDLED_PALETTE.fallbacks, className)
    return { ...box, color }
  }

  private async boxedTimelineFrame(
    deviceId: number,
    frameHandle: FrameHandle,
    frameData: Buffer,
    fw: number,
    fh: number,
    ownerId: string,
    bbox: PixelBox,
    label?: string,
    className?: string,
  ): Promise<SceneRenderings | null> {
    let nf: DecodedFrame | null = null
    let nfJpeg: NativeFullFrameJpeg | null = null
    // Track whether the fetch itself threw so the fallback branch does not warn a
    // SECOND time for the same failure (S3): a throw already logged below.
    let fetchThrew = false
    try {
      if (this.deps.getNativeFullFrameJpeg) {
        nfJpeg = await this.sharedNativeFullJpeg(frameHandle)
      } else {
        nf = await this.sharedNativeFullFrame(frameHandle)
      }
    } catch (err) {
      fetchThrew = true
      this.deps.logger.warn('native full frame fetch threw — 640 boxed fallback', {
        tags: { deviceId },
        meta: {
          deviceId,
          ownerId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
    try {
      if (nfJpeg && nfJpeg.width > 0 && nfJpeg.height > 0) {
        // Decode, draw and encode inside ONE libvips pipeline per rendering: no
        // raw RGB surface is ever built in this process (D867).
        const box = this.paletteBox(
          scaleBox(bbox, fw, fh, nfJpeg.width, nfJpeg.height, label),
          className,
        )
        const opts = { quality: MEDIA_QUALITY }
        const [boxed, clean] = await Promise.all([
          drawBoxedJpeg(nfJpeg.jpeg, nfJpeg.width, nfJpeg.height, [box], opts),
          drawBoxedJpeg(nfJpeg.jpeg, nfJpeg.width, nfJpeg.height, [], opts),
        ])
        return { boxed, clean }
      }
      if (nf && nf.format === 'rgb' && nf.width > 0 && nf.height > 0) {
        const box = this.paletteBox(scaleBox(bbox, fw, fh, nf.width, nf.height, label), className)
        const opts = { quality: MEDIA_QUALITY }
        const [boxed, clean] = await Promise.all([
          drawBoxedFrame(nf.data, nf.width, nf.height, [box], opts),
          drawBoxedFrame(nf.data, nf.width, nf.height, [], opts),
        ])
        return { boxed, clean }
      }
      if (!fetchThrew) {
        this.deps.logger.warn('native full frame miss — 640 boxed fallback (no upscale)', {
          tags: { deviceId },
          meta: { deviceId, ownerId, shmId: frameHandle.shmId },
        })
      }
      const box = this.paletteBox({ ...bbox, ...(label ? { label } : {}) }, className)
      const opts = { quality: MEDIA_QUALITY, maxWidth: SNAPSHOT_MAX_WIDTH }
      const [boxed, clean] = await Promise.all([
        drawBoxedFrame(frameData, fw, fh, [box], opts),
        drawBoxedFrame(frameData, fw, fh, [], opts),
      ])
      return { boxed, clean }
    } catch (err) {
      this.deps.logger.warn('event media: timeline frame encode failed', {
        tags: { deviceId },
        meta: {
          deviceId,
          ownerId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return null
    }
  }

  private async replaceKind(
    deviceId: number,
    trackId: string,
    kind: 'lastFrame' | 'thumbnail' | 'thumbnailSmall',
    timestamp: number,
    data: Buffer,
    provenance?: MediaProvenance,
  ): Promise<boolean> {
    try {
      await this.deps.mediaStore.putReplacing({
        deviceId,
        ownerKind: 'track',
        ownerId: trackId,
        kind,
        timestamp,
        data,
        ...(provenance !== undefined ? { provenance } : {}),
      })
      return true
    } catch (err) {
      this.deps.logger.debug(`event media: ${kind} replace failed`, {
        tags: { deviceId },
        meta: {
          deviceId,
          trackId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return false
    }
  }

  private async writeEventMedia(
    deviceId: number,
    frameHandle: FrameHandle,
    frameData: Buffer,
    fw: number,
    fh: number,
    ev: EventMediaTarget,
    cropPadding: number,
  ): Promise<void> {
    // The retired `crop` / `fullFrame` / `fullFrameBoxed` kinds are NO LONGER
    // produced (2026-07-21). The event's representative image is the track
    // `thumbnail` / native `keyFrame`; only the enrichment child crops
    // (`faceCrop`/`plateCrop`) are still written here, from the SAME frame handle
    // inside this synchronized window before the handle can recycle.
    // Child detail crops (faceCrop, plateCrop) — same NATIVE-first square-safe
    // 16:9 path as the parent `crop`, requested from the SAME frame handle
    // inside this synchronized window before the handle can recycle.
    if (ev.childCrops) {
      for (const child of ev.childCrops) {
        if (!isUsableBbox(child.bbox)) continue
        try {
          // faceCrop/plateCrop are DISPLAY media (operator gallery images), so
          // they get the BOUNDED fallback: native ROI → keyframe/RAM full frame →
          // the already-resolved ≤640 detection raster. Honest sub-native, NEVER
          // upscaled. A null (total miss) skips this child.
          const childCropData = await this.cropSubjectRegion(
            deviceId,
            frameHandle,
            frameData,
            fw,
            fh,
            child.bbox,
            cropPadding,
            `${ev.eventId}:${child.kind}`,
          )
          if (!childCropData) continue
          await this.deps.mediaStore.put({
            deviceId,
            // D476: `ev` is always an OBJECT event here (bbox/className come
            // from detection, never a motion/audio row).
            ownerKind: 'object',
            ownerId: ev.eventId,
            kind: child.kind,
            timestamp: ev.timestamp,
            data: childCropData,
          })
        } catch (err) {
          this.deps.logger.warn(`event media: ${child.kind} failed`, {
            tags: { deviceId },
            meta: {
              deviceId,
              eventId: ev.eventId,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
      }
    }
  }

  private async writeTrackFrame(
    deviceId: number,
    frameHandle: FrameHandle,
    frameData: Buffer,
    fw: number,
    fh: number,
    tf: TrackFrameTarget,
  ): Promise<boolean> {
    // The `firstFrame` timeline tile — native 960 with ONLY the track's box
    // (fallback ≤640, never an upscale). Returns whether the write ACTUALLY
    // landed (DEFECT A): a null encode or a `put` failure returns false so the
    // caller keeps retrying on later frames until a firstFrame persists.
    const scene = await this.boxedTimelineFrame(
      deviceId,
      frameHandle,
      frameData,
      fw,
      fh,
      tf.trackId,
      tf.bbox,
      tf.label,
      tf.className,
    )
    if (!scene) return false
    // Twin FIRST (see `writeSceneTwin`); its failure is swallowed there.
    await this.writeSceneTwin(deviceId, tf.trackId, tf.timestamp, scene.clean, 'append')
    try {
      await this.deps.mediaStore.put({
        deviceId,
        ownerKind: 'track',
        ownerId: tf.trackId,
        kind: 'firstFrame',
        timestamp: tf.timestamp,
        data: scene.boxed,
      })
      return true
    } catch (err) {
      this.deps.logger.warn('event media: track frame failed', {
        tags: { deviceId },
        meta: {
          deviceId,
          trackId: tf.trackId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return false
    }
  }
}
