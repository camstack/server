/**
 * Attribution-time SEMANTIC best-shot promotion and its capture re-fire.
 * Moved out of `pipeline-analytics/index.ts` verbatim (Plan B, extraction 2):
 * only the visibility of the entry point and the calls that now reach
 * `FrameMediaCapture` / the deps object changed.
 */
import type { MediaSettings } from '../media-settings.js'
import {
  promoteSemanticBestFrame,
  type SemanticCaptureRequest,
  type SemanticRecognitionFrame,
} from '../pipeline/semantic-promotion.js'
import type { TrackResidentState } from '../pipeline/track-resident-state.js'
import { captureCoalesceKey, type CaptureScheduler } from '../runtime/capture-scheduler.js'
import type {
  EventMediaDispatcher,
  TrackSnapshotTarget,
} from '../services/event-media-dispatcher.js'
import type { AddonContext } from '@camstack/types'
import type { FrameMediaCapture } from './frame-media-capture.js'
import { ENRICHMENT_CAPTURE_STALE_MS } from './capture-timing.js'

/** What the semantic best shot reads from the addon. */
export interface SemanticBestShotDeps {
  readonly ctxIfReady: () => AddonContext | null
  readonly residents: TrackResidentState
  readonly captureScheduler: () => CaptureScheduler
  readonly eventMediaDispatcher: () => EventMediaDispatcher | null
  readonly mediaCapture: FrameMediaCapture
  readonly resolveDeviceMediaSettings: (deviceId: number) => Promise<MediaSettings>
}

export class SemanticBestShot {
  constructor(private readonly deps: SemanticBestShotDeps) {}

  private get ctxIfReady(): AddonContext | null {
    return this.deps.ctxIfReady()
  }

  private get residents(): TrackResidentState {
    return this.deps.residents
  }

  private get captureScheduler(): CaptureScheduler {
    return this.deps.captureScheduler()
  }

  private get eventMediaDispatcher(): EventMediaDispatcher | null {
    return this.deps.eventMediaDispatcher()
  }

  private get mediaCapture(): FrameMediaCapture {
    return this.deps.mediaCapture
  }

  /** Attribution-time SEMANTIC best-shot promotion (D-semantic-bestshot,
   *  2026-08-21; see `pipeline/semantic-promotion.ts`): offer a frame from
   *  which a recognition SUCCEEDED to the best-frame ranking with the
   *  semantic tier, and re-fire the thumbnail + native keyFrame captures
   *  when it wins and the frame's pixels are still reachable. Callers: the
   *  FaceRecognizer's per-frame auto-match, and `routeDetailResults`' plate /
   *  fine-classification attribution. */
  promoteSemanticRecognition(input: SemanticRecognitionFrame): void {
    const ctx = this.ctxIfReady
    if (ctx === null) return
    promoteSemanticBestFrame(
      {
        observeBestFrame: (o) =>
          this.residents.observeBestFrame(
            o.deviceId,
            o.trackId,
            o.confidence,
            o.timestamp,
            o.edgeClear,
            o.centerScore,
            o.containment,
            o.sizeScore,
            o.squareFraction,
            o.semantic,
            o.canvasFill,
          ),
        recordBestSeenBbox: (deviceId, trackId, bbox) =>
          this.residents.recordBestSeenBbox(deviceId, trackId, bbox),
        captureBestShot: (request) => this.captureSemanticBestShot(request),
        logger: ctx.logger,
      },
      input,
    )
  }

  /** Re-fire the boxed `thumbnail` + native `keyFrame` for a SEMANTIC winner,
   *  through the SAME scheduler-held capture paths as the per-frame flow
   *  (coalescing, per-device budget and land-only bookkeeping identical). */
  private captureSemanticBestShot(request: SemanticCaptureRequest): void {
    const { deviceId, trackId, timestamp, bbox, frameHandle } = request
    // A SEMANTIC winner is a new best (the ranking said so): park both parcels
    // from this frame, replacing the previous ones (D422).
    this.mediaCapture.issueParkOrders(
      {
        deviceId,
        trackId,
        timestamp,
        frameHandle,
        bbox: { ...bbox },
        frameWidth: request.frameWidth,
        frameHeight: request.frameHeight,
      },
      ['keyFrame', 'thumbnail'],
      false,
    )
    // Native keyFrame: `persistKeyFrames` coalesces per track and marks landed.
    void this.mediaCapture.persistKeyFrames(deviceId, timestamp, [{ trackId, retry: false }])
    const dispatcher = this.eventMediaDispatcher
    if (!dispatcher) return
    if (this.captureScheduler.isKeyActive(captureCoalesceKey(deviceId, 'thumbnail', trackId))) {
      // An in-flight thumbnail capture is already resolving for this track —
      // stacking a second here would race it (same in-flight rule as the
      // per-frame path). The ranking already holds the semantic peak.
      this.ctxIfReady?.logger.debug('best-shot: semantic thumbnail skipped — capture in flight', {
        tags: { deviceId },
        meta: { trackId },
      })
      return
    }
    // Pin the ≤640 detection frame NOW, in the caller's synchronous window —
    // a queued exec can start late, by which time the ring slot is recycled
    // (mirrors the per-frame batch dispatch, 2026-07-23 regression fix).
    const pinnedFramePromise = dispatcher.resolvePinnedFrame(deviceId, frameHandle)
    const target: TrackSnapshotTarget = {
      trackId,
      timestamp,
      bbox: { ...bbox },
      appendSnapshot: false,
      rollingLastFrame: false,
      bestThumbnail: true,
      // The native keyFrame is dispatched above, not through this target.
      keyFrame: 'skip',
    }
    void this.captureScheduler
      .request({
        deviceId,
        kind: 'thumbnail',
        trackId,
        holdKeys: [captureCoalesceKey(deviceId, 'thumbnail', trackId)],
        // Same pin, same bound as the per-frame batch above: the queued closure
        // holds a ~0.7MB frame copy, so it must be droppable. `trackId` is what
        // lets `cancelForTrack` release it the moment the track closes.
        staleAfterMs: ENRICHMENT_CAPTURE_STALE_MS,
        exec: async () => {
          const [pinnedFrame, media] = await Promise.all([
            pinnedFramePromise,
            this.deps.resolveDeviceMediaSettings(deviceId),
          ])
          const res = await dispatcher.captureForFrame({
            deviceId,
            frameHandle,
            events: [],
            trackFrames: [],
            snapshots: [target],
            cropPadding: media.cropPadding,
            ...(pinnedFrame !== null ? { pinnedFrame } : {}),
          })
          for (const landedTrackId of res.thumbnailTrackIds) {
            this.residents.markThumbnailLanded(deviceId, landedTrackId)
          }
        },
      })
      .catch(() => {
        /* dispatcher/scheduler log their own failures; hold key releases on settle */
      })
  }
}
