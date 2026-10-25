/**
 * The two-plane detail dispatcher. Moved out of `pipeline-analytics/index.ts`
 * verbatim (Plan B, boot extraction): only the visibility of the entry point
 * changed. Every dependency is read through the deps object.
 */

import type {
  FrameHandle,
  IScopedLogger,
  RunDetailSubtreeInput,
  RunDetailSubtreeResult,
} from '@camstack/types'
import { nodePin } from '@camstack/types'
import type { TrackDetailFrame } from '../detail-dispatcher.js'
import { TrackDetailDispatcher } from '../detail-dispatcher.js'
import { DetailRoute } from '../frame/detail-route.js'
import { FrameMediaCapture } from '../media/frame-media-capture.js'
import { hasResolvedLabel } from '../pipeline/label-tier.js'
import { scaleSubjectIntoParcel } from '../pipeline/track-park.js'
import { TrackStore } from '../store/track-store.js'
import type { AnalyticsApi } from './boot-types.js'
import { DETAIL_FALLBACK_CROP_PADDING } from './boot-types.js'

export interface BuildDetailDispatcherDeps {
  readonly detailDispatcher: () => TrackDetailDispatcher | null
  readonly setDetailDispatcher: (value: TrackDetailDispatcher | null) => void
  readonly detailRoute: () => DetailRoute
  readonly mediaCapture: () => FrameMediaCapture
  readonly captureCrop: () =>
    | ((
        frameHandle: FrameHandle,
        bbox: { x: number; y: number; w: number; h: number },
        frameWidth: number,
        frameHeight: number,
        padding: number,
        maxWidth?: number,
        /** Tags the native-miss log. See `CaptureCropFn`. */
        deviceId?: number,
      ) => Promise<Buffer | null>)
    | null
  readonly setCaptureCrop: (
    value:
      | ((
          frameHandle: FrameHandle,
          bbox: { x: number; y: number; w: number; h: number },
          frameWidth: number,
          frameHeight: number,
          padding: number,
          maxWidth?: number,
          /** Tags the native-miss log. See `CaptureCropFn`. */
          deviceId?: number,
        ) => Promise<Buffer | null>)
      | null,
  ) => void
  readonly trackStore: () => TrackStore | null
}

export class BuildDetailDispatcher {
  constructor(protected readonly deps: BuildDetailDispatcherDeps) {}

  protected get detailDispatcher(): TrackDetailDispatcher | null {
    return this.deps.detailDispatcher()
  }

  protected set detailDispatcher(value: TrackDetailDispatcher | null) {
    this.deps.setDetailDispatcher(value)
  }

  protected get detailRoute(): DetailRoute {
    return this.deps.detailRoute()
  }

  protected get mediaCapture(): FrameMediaCapture {
    return this.deps.mediaCapture()
  }

  protected get captureCrop():
    | ((
        frameHandle: FrameHandle,
        bbox: { x: number; y: number; w: number; h: number },
        frameWidth: number,
        frameHeight: number,
        padding: number,
        maxWidth?: number,
        /** Tags the native-miss log. See `CaptureCropFn`. */
        deviceId?: number,
      ) => Promise<Buffer | null>)
    | null {
    return this.deps.captureCrop()
  }

  protected set captureCrop(value:
    | ((
        frameHandle: FrameHandle,
        bbox: { x: number; y: number; w: number; h: number },
        frameWidth: number,
        frameHeight: number,
        padding: number,
        maxWidth?: number,
        /** Tags the native-miss log. See `CaptureCropFn`. */
        deviceId?: number,
      ) => Promise<Buffer | null>)
    | null) {
    this.deps.setCaptureCrop(value)
  }

  protected get trackStore(): TrackStore | null {
    return this.deps.trackStore()
  }

  /** Two-plane detail dispatcher: the per-frame executor runs ONLY the root
   *  detector; face/clip/classifier/plate children are served per-track on
   *  demand via `pipelineRunner.runDetailSubtree`. The dispatcher owns the
   *  per-device schedulers, concurrency cap, and 1 s tick; result routing +
   *  the pinned call + crop fallback are injected here. */
  buildDetailDispatcher(api: AnalyticsApi, logger: IScopedLogger): void {
    const runnerApi = api.pipelineRunner
    this.detailDispatcher = new TrackDetailDispatcher({
      logger: logger.child('DetailDispatcher'),
      runDetailSubtree: async (
        input: RunDetailSubtreeInput,
        nodeId: string | undefined,
      ): Promise<RunDetailSubtreeResult | null> => {
        // Guard version skew: a runner without the method (older node) simply
        // yields no detail — the scheduler treats it as a miss.
        if (!runnerApi?.runDetailSubtree) return null
        if (nodeId !== undefined) return runnerApi.runDetailSubtree.mutate(input, nodePin(nodeId))
        return runnerApi.runDetailSubtree.mutate(input)
      },
      routeResults: (deviceId, trackId, details, frame) =>
        this.detailRoute.routeDetailResults(deviceId, trackId, details, frame),
      // The rung that survives a lease miss (D422): the track's PARKED key
      // frame, by track, from the node that answered the park — a lookup that
      // cannot miss on age. The subject's box is scaled into the parcel's
      // pixels here; the RECTANGLE is still the runner's to derive (D52).
      //
      // Not CaptureScheduler-routed, like the `cropJpeg` rung beside it: the
      // dispatcher already bounds itself at `maxInFlightPerDevice` (2), and
      // the read only happens after rung 1 missed.
      captureParkedFrame: async (_deviceId: number, trackId: string) => {
        const parcel = await this.mediaCapture.fetchParkedParcel(trackId, 'keyFrame')
        if (parcel === null) return null
        return {
          base64: parcel.jpeg.toString('base64'),
          width: parcel.width,
          height: parcel.height,
          bbox: scaleSubjectIntoParcel(parcel.info.subject, parcel.width, parcel.height),
          nodeId: parcel.info.nodeId,
          timestamp: parcel.timestamp,
        }
      },
      captureCropBase64: async (frame: TrackDetailFrame): Promise<string | null> => {
        if (frame.frameHandle === undefined || !this.captureCrop) return null
        const buf = await this.captureCrop(
          frame.frameHandle,
          { ...frame.bbox },
          frame.frameWidth,
          frame.frameHeight,
          DETAIL_FALLBACK_CROP_PADDING,
        )
        return buf ? buf.toString('base64') : null
      },
      // Identity-aware face chain: a PERIODIC face-detection refresh on a track
      // that already has a resolved label runs geometry-only (drops ArcFace).
      //
      // `displayLabel`, NOT `.label`. An identity is a TIER-2 value and lands in
      // `subLabel`; reading the tier-1 column meant a track ArcFace had already
      // named reported "no label" forever and kept re-embedding it on every
      // periodic tick — the exact cost this gate exists to avoid — while a track
      // carrying only a tier-1 sub-class (`van`) DID suppress its face chain,
      // which is the opposite of what was wanted.
      hasTrackLabel: (trackId: string): boolean =>
        hasResolvedLabel(this.trackStore?.getActiveByTrack(trackId)),
    })
  }
}
