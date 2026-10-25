/**
 * Face and plate recognizers, the keyFrame plate crop and the object-embedding
 * store. Moved out of `pipeline-analytics/index.ts` verbatim (Plan B, boot
 * extraction): only the visibility of the entry point changed. Every
 * dependency is read through the deps object.
 */

import type {
  AddonContext,
  IScopedLogger,
  PipelineAnalyticsFaceGalleryChangedPayload,
  PipelineAnalyticsPlateGalleryChangedPayload,
} from '@camstack/types'
import { BUILTIN_CLIP_MODELS } from '../../shared/clip/clip-model-registry.js'
import { extractCrop } from '../../shared/frame/crop-extractor.js'
import { decodeJpegToRgb } from '../../shared/frame/encode-crop.js'
import { copyFaceCropIfTrackHasNoThumbnail } from '../copy-face-crop-preview.js'
import type { FaceIdentityVerdict } from '../face-recognizer.js'
import { FaceRecognizer } from '../face-recognizer.js'
import { FaceSourceFrameKeeper } from '../face-source-frame.js'
import { FaceSourceStats } from '../face-source-stats.js'
import { ENRICHMENT_CAPTURE_STALE_MS } from '../media/capture-timing.js'
import { FrameMediaCapture } from '../media/frame-media-capture.js'
import { SemanticBestShot } from '../media/semantic-best-shot.js'
import type { DisplayCropFn } from '../pipeline/display-crop.js'
import { recomputeTrackImportance } from '../pipeline/key-event-recompute.js'
import { createKeyFrameCrop } from '../pipeline/keyframe-crop.js'
import { TrackResidentState } from '../pipeline/track-resident-state.js'
import { PlateRecognizer } from '../plate-recognizer.js'
import { CaptureScheduler, captureCoalesceKey } from '../runtime/capture-scheduler.js'
import { createFaceSourceParkPort } from '../runtime/face-source-park-port.js'
import { AnalyticsFailureReport } from '../runtime/failure-report.js'
import type { NativeFrameTransport } from '../runtime/native-frame-transport.js'
import { NodeLivenessMirror } from '../runtime/node-liveness.js'
import type { ParkedFrameClient } from '../runtime/parked-frame-client.js'
import { EventStore } from '../store/event-store.js'
import { ObjectEmbeddingStore } from '../store/object-embedding-store.js'
import { TrackStore } from '../store/track-store.js'
import { makeIdentityVerdictObserver } from '../tracking-bench/recorder/identity-observer.js'
import { TapeRecorder } from '../tracking-bench/recorder/tape-recorder.js'
import type { AnalyticsApi, AnalyticsStores } from './boot-types.js'
import {
  KEYFRAME_CROP_MAX_SAMPLE_GAP_MS,
  KEYFRAME_CROP_MAX_SKEW_MS,
  KEYFRAME_CROP_MIN_SUBJECT_IOU,
} from './boot-types.js'

export interface BuildRecognizersDeps {
  readonly captureDisplayCropFn: () => DisplayCropFn | null
  readonly setCaptureDisplayCropFn: (value: DisplayCropFn | null) => void
  readonly faceRecognizer: () => FaceRecognizer | null
  readonly setFaceRecognizer: (value: FaceRecognizer | null) => void
  readonly tapeRecorder: () => TapeRecorder | null
  readonly noteVerdictOnTracker: () => (verdict: FaceIdentityVerdict) => void
  readonly ctx: () => AddonContext<Record<string, unknown>>
  readonly captureScheduler: () => CaptureScheduler
  readonly trackStore: () => TrackStore | null
  readonly eventStore: () => EventStore | null
  readonly residents: () => TrackResidentState
  readonly emitFaceGalleryChanged: (payload: PipelineAnalyticsFaceGalleryChangedPayload) => void
  readonly semanticBestShot: () => SemanticBestShot
  readonly mediaCapture: () => FrameMediaCapture
  readonly parkedFrames: () => ParkedFrameClient | null
  readonly nodeLiveness: () => NodeLivenessMirror
  readonly faceSourceStats: () => FaceSourceStats
  readonly plateRecognizer: () => PlateRecognizer | null
  readonly setPlateRecognizer: (value: PlateRecognizer | null) => void
  readonly failureReport: () => AnalyticsFailureReport
  readonly emitPlateGalleryChanged: (payload: PipelineAnalyticsPlateGalleryChangedPayload) => void
  readonly objectEmbeddingStore: () => ObjectEmbeddingStore | null
  readonly setObjectEmbeddingStore: (value: ObjectEmbeddingStore | null) => void
}

export class BuildRecognizers {
  constructor(protected readonly deps: BuildRecognizersDeps) {}

  protected get captureDisplayCropFn(): DisplayCropFn | null {
    return this.deps.captureDisplayCropFn()
  }

  protected set captureDisplayCropFn(value: DisplayCropFn | null) {
    this.deps.setCaptureDisplayCropFn(value)
  }

  protected get faceRecognizer(): FaceRecognizer | null {
    return this.deps.faceRecognizer()
  }

  protected set faceRecognizer(value: FaceRecognizer | null) {
    this.deps.setFaceRecognizer(value)
  }

  protected get tapeRecorder(): TapeRecorder | null {
    return this.deps.tapeRecorder()
  }

  protected get noteVerdictOnTracker(): (verdict: FaceIdentityVerdict) => void {
    return this.deps.noteVerdictOnTracker()
  }

  protected get ctx(): AddonContext<Record<string, unknown>> {
    return this.deps.ctx()
  }

  protected get captureScheduler(): CaptureScheduler {
    return this.deps.captureScheduler()
  }

  protected get trackStore(): TrackStore | null {
    return this.deps.trackStore()
  }

  protected get eventStore(): EventStore | null {
    return this.deps.eventStore()
  }

  protected get residents(): TrackResidentState {
    return this.deps.residents()
  }

  protected emitFaceGalleryChanged(payload: PipelineAnalyticsFaceGalleryChangedPayload): void {
    return this.deps.emitFaceGalleryChanged(payload)
  }

  protected get semanticBestShot(): SemanticBestShot {
    return this.deps.semanticBestShot()
  }

  protected get mediaCapture(): FrameMediaCapture {
    return this.deps.mediaCapture()
  }

  protected get parkedFrames(): ParkedFrameClient | null {
    return this.deps.parkedFrames()
  }

  protected get nodeLiveness(): NodeLivenessMirror {
    return this.deps.nodeLiveness()
  }

  protected get faceSourceStats(): FaceSourceStats {
    return this.deps.faceSourceStats()
  }

  protected get plateRecognizer(): PlateRecognizer | null {
    return this.deps.plateRecognizer()
  }

  protected set plateRecognizer(value: PlateRecognizer | null) {
    this.deps.setPlateRecognizer(value)
  }

  protected get failureReport(): AnalyticsFailureReport {
    return this.deps.failureReport()
  }

  protected emitPlateGalleryChanged(payload: PipelineAnalyticsPlateGalleryChangedPayload): void {
    return this.deps.emitPlateGalleryChanged(payload)
  }

  protected get objectEmbeddingStore(): ObjectEmbeddingStore | null {
    return this.deps.objectEmbeddingStore()
  }

  protected set objectEmbeddingStore(value: ObjectEmbeddingStore | null) {
    this.deps.setObjectEmbeddingStore(value)
  }

  /** Face + plate recognizers, the durable keyFrame-derived plate crop and the
   *  object-embedding store — pre-S7 construction order. Gallery-crop fetches
   *  route through the CaptureScheduler at the injection point (S4). */
  buildRecognizers(
    api: AnalyticsApi,
    logger: IScopedLogger,
    stores: AnalyticsStores,
    transport: NativeFrameTransport,
  ): void {
    const captureDisplayCrop = transport.captureDisplayCrop
    this.captureDisplayCropFn = captureDisplayCrop
    this.faceRecognizer = new FaceRecognizer({
      // D681 × D683: the recognizer's settled verdict per track reaches the
      // tape (switched-on cameras only — the recorder checks) and the tracker
      // (the identity cannot-link, review C3) through ONE closure, in the same
      // call: live applies it when the tape records it, which is what makes
      // live and replay apply the same cannot-link. Sinks are read per call:
      // the recorder is created later, in `startTrackingTapes`. The operator's
      // paths (manual assignment, rescore) write no tape record and never
      // reach this list.
      onIdentityVerdict: makeIdentityVerdictObserver(
        () =>
          this.tapeRecorder === null
            ? [this.noteVerdictOnTracker]
            : [(v) => this.tapeRecorder?.onIdentity(v), this.noteVerdictOnTracker],
        this.ctx.logger.child('identity-verdict'),
      ),
      identityStore: stores.identityStore,
      faceStore: stores.faceStore,
      mediaStore: stores.mediaStore,
      trackStore: stores.trackStore,
      eventStore: stores.eventStore,
      // S4: the gallery-crop fetch goes through the CaptureScheduler at the
      // injection point (the recognizer's internals stay scheduler-unaware).
      // kind 'face' (enrichment priority), coalesced per track — two
      // overlapping face-crop fetches for the SAME track join one native
      // round-trip — and stale-dropped once the handle's retained surface is
      // gone. A `null` (miss/drop) is the recognizer's existing retry path.
      captureCrop: (frameHandle, bbox, frameWidth, frameHeight, padding, ownerId, deviceId) =>
        this.captureScheduler.request({
          deviceId,
          trackId: ownerId,
          kind: 'face',
          coalesceKey: captureCoalesceKey(deviceId, 'face', ownerId),
          staleAfterMs: ENRICHMENT_CAPTURE_STALE_MS,
          exec: () =>
            captureDisplayCrop(frameHandle, bbox, frameWidth, frameHeight, padding, ownerId),
        }),
      recomputeImportance: (trackId) => {
        const trackStore = this.trackStore
        const eventStore = this.eventStore
        if (!trackStore || !eventStore) return Promise.resolve()
        return recomputeTrackImportance({ trackStore, eventStore }, trackId)
      },
      // The STRICT twin of the `markFaceDetected` call in `routeDetailResults`.
      // That one fires at the top of the face branch and means "a detector
      // found a face"; this one fires only once the recognizer has PERSISTED a
      // gallery row, and means "there is a crop + embedding an operator could
      // assign". `stores.trackStore` is captured rather than read off `this` so
      // the mark cannot silently no-op against a half-built addon.
      markEmbeddedFace: (trackId) => stores.trackStore.markEmbeddedFace(trackId),
      copyCropToTrackPreview: async (input) => {
        const stoodIn = await copyFaceCropIfTrackHasNoThumbnail(
          {
            listTrackMedia: (trackId) => stores.mediaStore.listByOwner('track', trackId),
            putTrackThumbnail: (put) =>
              stores.mediaStore.put({
                deviceId: put.deviceId,
                ownerKind: 'track',
                ownerId: put.trackId,
                kind: 'thumbnail',
                timestamp: put.timestamp,
                data: put.data,
                provenance: put.provenance,
              }),
          },
          input,
        )
        // A stand-in is a REPORTED substitution, never a silent one (D276):
        // this is the branch the operator reads as "faccia senza la persona" [face without the person],
        // and the provisional mark is what lets a late native frame replace it.
        if (stoodIn) {
          this.ctx.logger.info('face crop stood in as track thumbnail (provisional)', {
            tags: { deviceId: input.deviceId },
            meta: { trackId: input.trackId },
          })
        }
      },
      // Design B: link the face row to the track's shared native key frame
      // captured by the object-embedding best path (same live-frame window).
      getKeyFrameMediaId: (trackId) => this.residents.keyFrameMediaId(trackId),
      emitFaceGalleryChanged: (payload) => this.emitFaceGalleryChanged(payload),
      // SEMANTIC best-shot: a frame on which a face was RESOLVED is the frame
      // to show — promote it in the best-shot ranking (semantic tier) and
      // re-fire the captures off the still-live detail-plane handle. D406: an
      // IDENTIFIED face is `face`; a resolved face belonging to nobody in the
      // gallery is `face-visible` and carries the same tier without claiming
      // an identity. See
      // `pipeline/semantic-promotion.ts`.
      onSemanticFace: (face) =>
        this.semanticBestShot.promoteSemanticRecognition({
          deviceId: face.deviceId,
          trackId: face.trackId,
          timestamp: face.timestamp,
          bbox: face.bbox,
          frameWidth: face.frameWidth,
          frameHeight: face.frameHeight,
          kind: face.identityId !== undefined ? 'face' : 'face-visible',
          score: face.matchScore ?? face.confidence,
          confidence: face.confidence,
          ...(face.frameHandle !== undefined ? { frameHandle: face.frameHandle } : {}),
        }),
      onLiveHierarchy: (input) => this.mediaCapture.requestTrackHierarchy(input),
      // D644: every BUFFERED face keeps the full frame it was detected on.
      // Gated per camera by `keepSourceFrames` (default OFF).
      faceSourceFrames: new FaceSourceFrameKeeper({
        port: createFaceSourceParkPort({
          client: () => this.parkedFrames,
          isNodeOffline: (nodeId) => this.nodeLiveness.isKnownOffline(nodeId, Date.now()),
          onParkSettled: (deviceId, ms, parked) =>
            this.faceSourceStats.noteParkMs(deviceId, ms, parked),
          logger: logger.child('FaceSourceFrames'),
        }),
        media: {
          put: (input) => stores.mediaStore.put(input),
          trackKeyFrame: async (trackId) => {
            const row = (await stores.mediaStore.listInfoByOwner('track', trackId)).find(
              (m) => m.kind === 'keyFrame',
            )
            return row === undefined ? null : { mediaId: row.mediaId, timestamp: row.timestamp }
          },
        },
        stats: this.faceSourceStats,
        logger: logger.child('FaceSourceFrames'),
      }),
      logger: logger.child('FaceRecognizer'),
    })
    void this.faceRecognizer.refreshGallery()

    // DURABLE last-resort plate crop: when the async detail-plane gallery capture
    // missed every LIVE tier (cross-node frame eviction), cut the plate ROI from
    // the track's persisted native keyFrame (temporally guarded). Reuses the
    // existing decode + crop utilities; `getByKey` yields the frame + timestamp.
    const plateMediaStore = stores.mediaStore
    const deriveCropFromKeyFrame = createKeyFrameCrop({
      getMedia: async (mediaKey) => {
        const m = await plateMediaStore.getBytesById(mediaKey)
        return m ? { bytes: m.bytes, timestamp: m.timestamp } : null
      },
      decodeJpegToRgb: (jpeg) => decodeJpegToRgb(jpeg),
      cropRegionToJpeg: async (bytes, w, h, norm) => (await extractCrop(bytes, w, h, norm)).crop,
      maxSkewMs: KEYFRAME_CROP_MAX_SKEW_MS,
      minSubjectIou: KEYFRAME_CROP_MIN_SUBJECT_IOU,
      maxSubjectSampleGapMs: KEYFRAME_CROP_MAX_SAMPLE_GAP_MS,
      logger: logger.child('KeyFrameCrop'),
    })
    this.plateRecognizer = new PlateRecognizer({
      plateStore: stores.plateStore,
      vehicleStore: stores.vehicleStore,
      mediaStore: stores.mediaStore,
      // Per-camera OCR outcome counter. The accepted-read call is the
      // denominator for both refusal reasons and for the empty-read branch
      // counted in `routeDetailResults`.
      notePlateRead: (deviceId, reason) => this.failureReport.notePlateRead(deviceId, reason),
      // S4: scheduler-routed at the injection point, same pattern as the face
      // crop above — kind 'plate', per-track coalesce, enrichment staleness.
      captureCrop: (frameHandle, bbox, frameWidth, frameHeight, padding, ownerId, deviceId) =>
        this.captureScheduler.request({
          deviceId,
          trackId: ownerId,
          kind: 'plate',
          coalesceKey: captureCoalesceKey(deviceId, 'plate', ownerId),
          staleAfterMs: ENRICHMENT_CAPTURE_STALE_MS,
          exec: () =>
            captureDisplayCrop(frameHandle, bbox, frameWidth, frameHeight, padding, ownerId),
        }),
      deriveCropFromKeyFrame,
      // Design B: link the plate row to the track's shared native key frame
      // captured by the object-embedding best path (same live-frame window).
      getKeyFrameMediaId: (trackId) => this.residents.keyFrameMediaId(trackId),
      emitPlateGalleryChanged: (payload) => this.emitPlateGalleryChanged(payload),
      onLiveHierarchy: (input) => this.mediaCapture.requestTrackHierarchy(input),
      logger: logger.child('PlateRecognizer'),
    })
    void this.plateRecognizer.refreshGallery()

    // The vector store is now the ONLY home for these vectors — there is no
    // settings collection behind it and no mirror. Its absence is therefore a
    // hard failure for semantic search, not a degraded mode, so say so once at
    // boot rather than letting every search return an unexplained empty list.
    const vectorStore = api.vectorStore
    if (vectorStore === undefined) {
      // The provider is the sqlite-settings builtin, so this should be
      // unreachable on a healthy hub — which is exactly why it is worth a line
      // if it ever happens.
      logger.warn('vector-store capability unavailable — CLIP semantic search is disabled', {
        meta: { provider: 'sqlite-settings (builtin)' },
      })
    } else {
      this.objectEmbeddingStore = new ObjectEmbeddingStore({
        vectorStore,
        logger: logger.child('ObjectEmbeddingStore'),
        clipModels: BUILTIN_CLIP_MODELS,
      })
    }
  }
}
