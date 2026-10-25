/**
 * The detail route — one track's `runDetailSubtree` results (two-plane detail
 * dispatch) into the per-track consumers: the FaceRecognizer, the
 * object-embedding store, the plate gallery and the enrichment label. Moved
 * out of `pipeline-analytics/index.ts` verbatim (Plan B, extraction 4): only
 * the visibility of the entry point changed. Every dependency is read through
 * the deps object — getters for what the addon opens in `onInitialize`.
 */
import { type AddonContext, type DetailResult, errMsg } from '@camstack/types'
import { routeClipDetailToStore } from '../clip-detail-route.js'
import type { TrackDetailFrame } from '../detail-dispatcher.js'
import type { FaceRecognizer } from '../face-recognizer.js'
import type { FaceSettings } from '../face-settings.js'
import type { SemanticBestShot } from '../media/semantic-best-shot.js'
import type { MediaSettings } from '../media-settings.js'
import type { OverlayDetailStateStore } from '../overlay-state.js'
import { detailSemanticTrigger } from '../pipeline/detail-semantic-gate.js'
import { semanticFrameForDetailAttribution } from '../pipeline/semantic-promotion.js'
import type { TrackResidentState } from '../pipeline/track-resident-state.js'
import type { PlateRecognizer } from '../plate-recognizer.js'
import {
  type AnalyticsFailureReport,
  REASON_EMPTY_READ,
  REASON_NO_BBOX,
} from '../runtime/failure-report.js'
import type { ObjectEmbeddingStore } from '../store/object-embedding-store.js'
import type { TrackStore } from '../store/track-store.js'
import type { EnrichmentFanout } from './enrichment-fanout.js'

/** What the detail route reads from the addon. */
export interface DetailRouteDeps {
  /** The addon context — throws outside the initialized window. */
  readonly ctx: () => AddonContext
  readonly residents: TrackResidentState
  readonly overlayState: OverlayDetailStateStore
  readonly failureReport: AnalyticsFailureReport
  readonly trackStore: () => TrackStore | null
  readonly faceRecognizer: () => FaceRecognizer | null
  readonly plateRecognizer: () => PlateRecognizer | null
  readonly objectEmbeddingStore: () => ObjectEmbeddingStore | null
  readonly semanticBestShot: () => SemanticBestShot
  readonly enrichmentFanout: () => EnrichmentFanout
  readonly resolveGlobalFaceEnabled: () => Promise<boolean>
  readonly resolveDeviceFaceSettings: (deviceId: number) => Promise<FaceSettings>
  readonly resolveDeviceMediaSettings: (deviceId: number) => Promise<MediaSettings>
}

/**
 * Decode a base64 little-endian float32 vector (the `DetailResult.embedding`
 * wire encoding produced by `runDetailSubtree`) back into a plain number[].
 */
function decodeEmbeddingBase64(base64: string): number[] {
  const bytes = Buffer.from(base64, 'base64')
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  return Array.from(view)
}

export class DetailRoute {
  constructor(private readonly deps: DetailRouteDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get residents(): TrackResidentState {
    return this.deps.residents
  }

  private get overlayState(): OverlayDetailStateStore {
    return this.deps.overlayState
  }

  private get failureReport(): AnalyticsFailureReport {
    return this.deps.failureReport
  }

  private get trackStore(): TrackStore | null {
    return this.deps.trackStore()
  }

  private get faceRecognizer(): FaceRecognizer | null {
    return this.deps.faceRecognizer()
  }

  private get plateRecognizer(): PlateRecognizer | null {
    return this.deps.plateRecognizer()
  }

  private get objectEmbeddingStore(): ObjectEmbeddingStore | null {
    return this.deps.objectEmbeddingStore()
  }

  private get semanticBestShot(): SemanticBestShot {
    return this.deps.semanticBestShot()
  }

  private get enrichmentFanout(): EnrichmentFanout {
    return this.deps.enrichmentFanout()
  }

  private resolveGlobalFaceEnabled(): Promise<boolean> {
    return this.deps.resolveGlobalFaceEnabled()
  }

  private resolveDeviceFaceSettings(deviceId: number): Promise<FaceSettings> {
    return this.deps.resolveDeviceFaceSettings(deviceId)
  }

  private resolveDeviceMediaSettings(deviceId: number): Promise<MediaSettings> {
    return this.deps.resolveDeviceMediaSettings(deviceId)
  }

  /**
   * Route one track's `runDetailSubtree` results (two-plane detail dispatch)
   * into the EXISTING per-track consumers, discriminated by payload SHAPE:
   *  • embedding + alignedCropJpeg → FACE (arcface): the FaceRecognizer's
   *    candidate/best-face/gallery/keyFrame path (input source cut-over);
   *  • embedding only → CLIP object embedding → the object-embedding store
   *    (semantic search);
   *  • label only → classifier answer / plate OCR text → the track's
   *    enrichment label the notifier/UI already read.
   * Best-effort (D8): a per-detail failure is logged and never propagated.
   */
  async routeDetailResults(
    deviceId: number,
    trackId: string,
    details: readonly DetailResult[],
    frame: TrackDetailFrame,
  ): Promise<void> {
    for (const d of details) {
      try {
        // Discriminate by the detail's OWN class, NOT by alignedCropJpeg
        // presence. A face detail carries className 'face' (the face-detection
        // subtree root's outputClass) and an embedding; its aligned crop may be
        // absent when the embedder skipped alignment (no landmarks, or a native
        // path), so the route must NOT hinge on `alignedCropJpeg` or a real face
        // would misroute into the CLIP store and starve the FaceRecognizer. The
        // synthesized CLIP detail carries className 'embedding' (clip-embedding's
        // outputClass), so it falls through to the clip route below.
        const isFaceDetail = d.className === 'face'
        if (isFaceDetail) {
          // "A face detector found a face" — recorded HERE, at the top of the
          // face branch, and nowhere further down. Everything below this line is
          // a gate that can legitimately refuse the face (recognition disabled,
          // `minFacePx`, no embedding, no gallery match), and a flag written past
          // any of them would be true only for faces that were RECOGNISED —
          // which is precisely the set the viewer's badge must exclude.
          // Set-once and in-RAM while the track is live; see `markFaceDetected`.
          await this.trackStore?.markFaceDetected(trackId)
        }
        if (isFaceDetail && d.bbox !== undefined) {
          // Overlay geometry capture (two-plane re-injection): recorded
          // regardless of whether the FaceRecognizer is present/enabled —
          // `routeFaceDetail` below returns early in that case, but the
          // live overlay must keep tracking the face box either way.
          this.overlayState.noteFaceDetail(
            deviceId,
            trackId,
            { x: d.bbox.x, y: d.bbox.y, w: d.bbox.w, h: d.bbox.h },
            d.score,
            frame.timestamp,
          )
        }
        if (isFaceDetail && d.embedding !== undefined) {
          await this.routeFaceDetail(deviceId, trackId, d, frame)
        } else if (d.embedding !== undefined) {
          await this.routeClipDetail(deviceId, trackId, d, frame.timestamp)
        } else if (d.label !== undefined && d.label.length > 0) {
          if (d.className === 'plate' && d.bbox !== undefined) {
            this.overlayState.notePlateDetail(
              deviceId,
              trackId,
              { x: d.bbox.x, y: d.bbox.y, w: d.bbox.w, h: d.bbox.h },
              d.score,
              d.label,
              frame.timestamp,
            )
            // Two-plane design: plate-ocr runs on the DETAIL plane, so the read
            // never reaches PlateRecognizer.processFrame (which scans per-frame
            // tracks). Feed it here so the gallery collects the best read + crop
            // and onTrackEnd persists it — otherwise the label rides the event
            // but plateGallery stays empty (0 plateCrop).
            if (this.plateRecognizer) {
              const mediaSettings = await this.resolveDeviceMediaSettings(deviceId)
              const body = this.residents.bestSeenBbox(trackId)
              await this.plateRecognizer.observePlateRead({
                deviceId,
                trackId,
                text: d.label,
                score: d.score,
                bbox: { x: d.bbox.x, y: d.bbox.y, w: d.bbox.w, h: d.bbox.h },
                timestamp: frame.timestamp,
                frameWidth: frame.frameWidth,
                frameHeight: frame.frameHeight,
                cropPadding: mediaSettings.cropPadding,
                ...(frame.frameHandle !== undefined ? { frameHandle: frame.frameHandle } : {}),
                ...(body !== undefined
                  ? { bodyBbox: { x: body.x, y: body.y, w: body.w, h: body.h } }
                  : {}),
              })
            }
            // SEMANTIC best-shot, on the READ (D406). The OCR came back on
            // THIS frame's pixels — that is the recognition, and it is what
            // the operator asked the best shot to show ("il frame al momento
            // della targa è decisamente migliore come best shot" [the frame at the moment of the plate is decidedly better as best shot], track
            // 718acf29). Whether the text then wins a tiered label slot is a
            // second, fallible decision; gating the promotion on it left the
            // best shot 5.7 s before the plate. `detailSemanticTrigger` keeps
            // this site and the label-write site mutually exclusive.
            if (detailSemanticTrigger(d.className) === 'recognition') {
              this.semanticBestShot.promoteSemanticRecognition(
                semanticFrameForDetailAttribution(deviceId, trackId, d, frame),
              )
            }
          }
          // For a plate read, prefer the recognized vehicle NAME over the raw OCR
          // text when the matcher names it. An IMPLAUSIBLE read (junk OCR off a
          // distant plate — resolveLabel returns null) stamps NO label at all:
          // better an unlabeled vehicle than "N"/"@em" flooding the track list.
          const resolved =
            d.className === 'plate'
              ? (this.plateRecognizer?.resolveLabelWithVehicle(d.label, d.score) ?? null)
              : { text: d.label }
          if (resolved !== null && resolved.text !== undefined) {
            const applied = await this.enrichmentFanout.applyTrackEnrichmentLabel(
              deviceId,
              trackId,
              resolved.text,
              d,
              frame.timestamp,
              // Present only for a read a GALLERY VEHICLE claimed — the id a
              // rule matches on, so a renamed vehicle keeps matching.
              resolved.vehicleId,
            )
            // SEMANTIC best-shot for a fine CLASSIFICATION: the class the
            // track ACCEPTED proved something about the subject — promote its
            // frame in the best-shot ranking (semantic tier) and re-fire the
            // captures while the detail plane's handle is still live. The
            // write gate stays HERE, and only here: a refused class proved
            // nothing the track keeps. A PLATE promoted on its read, above
            // (D406) — `detailSemanticTrigger` is what keeps the two sites
            // from both firing on one detail.
            if (detailSemanticTrigger(d.className) === 'label-write' && applied.trackWritten) {
              // D276: the promoted bbox is ALWAYS the SUBJECT box — composing
              // it in `semanticFrameForDetailAttribution` (not inline) is what
              // keeps the plate DETAIL box out of the ranking, the best-seen
              // record and the re-fired thumbnail crop.
              this.semanticBestShot.promoteSemanticRecognition(
                semanticFrameForDetailAttribution(deviceId, trackId, d, frame),
              )
            }
          }
        } else if (d.className === 'plate') {
          // THE SILENT BRANCH, now counted.
          //
          // A `plate` detail with an empty label matched no arm of this chain
          // and left NOTHING behind: no store write, no log, no row. ~35% of
          // reads on 2026-08-28 ended here, and a camera whose OCR always comes
          // back empty was indistinguishable from a camera that never saw a
          // plate — which needs a completely different fix.
          //
          // Not logged per read (this runs on the detail plane at track rate);
          // counted per camera, with `notePlateRead` on the accepted path as the
          // denominator. Vocabulary shared with `PlateRecognizer` so a refusal
          // here and a refusal there are the same word (D276's discipline).
          this.failureReport.notePlateRead(
            deviceId,
            d.bbox === undefined ? REASON_NO_BBOX : REASON_EMPTY_READ,
          )
        }
      } catch (err) {
        this.ctx.logger.warn('detail result route failed', {
          tags: { deviceId },
          meta: { trackId, stepId: d.stepId, error: errMsg(err) },
        })
      }
    }
  }

  /** Face-embedding detail → the FaceRecognizer (same gate + logic as the
   *  former per-frame face path; only the input source moved). */
  private async routeFaceDetail(
    deviceId: number,
    trackId: string,
    detail: DetailResult,
    frame: TrackDetailFrame,
  ): Promise<void> {
    if (!this.faceRecognizer || detail.embedding === undefined) return
    if (!(await this.resolveGlobalFaceEnabled())) return
    const [settings, media] = await Promise.all([
      this.resolveDeviceFaceSettings(deviceId),
      this.resolveDeviceMediaSettings(deviceId),
    ])
    // Min-face-size gate (#26.1), earliest post-analysis point: a face below
    // `minFacePx` is too small for reliable ArcFace matching and drives the
    // observed auto-match false positives. NATIVE-AWARE (2026-07-22): measure
    // the runner-supplied native short side when present — `detail.bbox` is
    // detection-frame px (≈6× smaller on a 4K camera), and gating on it
    // silently discarded EVERY face from the outdoor cameras (90–200px real
    // faces read as 15–33px). Detection-space bbox is the fallback only for
    // older runners; a detail with neither measure falls through to the
    // recognizer's own candidate gate.
    const faceShortSidePx =
      detail.nativeFaceShortSidePx ??
      (detail.bbox !== undefined ? Math.min(detail.bbox.w, detail.bbox.h) : undefined)
    if (faceShortSidePx !== undefined && faceShortSidePx < settings.minFacePx) {
      // Debug (not warn): distant faces below the gate are routine; the size +
      // pixel space are named so a future "no faces" report can rule this out.
      this.ctx.logger.debug('face detail below minFacePx — dropped', {
        tags: { deviceId },
        meta: {
          trackId,
          faceShortSidePx: Math.round(faceShortSidePx),
          minFacePx: settings.minFacePx,
          gatedOn: detail.nativeFaceShortSidePx !== undefined ? 'native' : 'bbox',
        },
      })
      return
    }
    await this.faceRecognizer.ingestFaceDetail({
      deviceId,
      trackId,
      timestamp: frame.timestamp,
      frameWidth: frame.frameWidth,
      frameHeight: frame.frameHeight,
      score: detail.score,
      embedding: decodeEmbeddingBase64(detail.embedding),
      // The RAW magnitude — the quality signal `embedding` (the unit vector)
      // cannot carry. Absent from a runner older than 2026-08-19.
      ...(detail.embeddingMagnitude !== undefined
        ? { embeddingMagnitude: detail.embeddingMagnitude }
        : {}),
      // The model the vector was measured in, straight from the node that ran
      // it. This is what lets the matcher's same-model gate actually fire —
      // without it the recognizer named the probe after the GALLERY and the
      // gate compared the gallery with itself. Absent from a runner older than
      // 2026-08-20, which degrades to that old assumption.
      ...(detail.embeddingModelId !== undefined
        ? { embeddingModelId: detail.embeddingModelId }
        : {}),
      parentBbox: { ...frame.bbox },
      ...(detail.bbox !== undefined ? { faceBbox: { ...detail.bbox } } : {}),
      // Forward the runner's NATIVE face measure — without it the recognizer's
      // own candidate gate re-derives the size from `faceBbox` (detection-frame
      // px, ≈6× smaller on a 4K camera) and re-discards every face this route
      // just admitted (the 2026-07-18→23 zero-faces regression: both gates were
      // made native-aware on 2026-07-22 but this hand-off between them wasn't).
      ...(detail.nativeFaceShortSidePx !== undefined
        ? { nativeFaceShortSidePx: detail.nativeFaceShortSidePx }
        : {}),
      ...(detail.alignedCropJpeg !== undefined ? { alignedCropJpeg: detail.alignedCropJpeg } : {}),
      // D644: the landmarks travel to the face's stored source frame. Absent
      // from a runner (or a framework closure) that predates the field.
      ...(detail.landmarks !== undefined ? { landmarks: detail.landmarks } : {}),
      settings,
      cropPadding: media.cropPadding,
      ...(frame.frameHandle !== undefined ? { frameHandle: frame.frameHandle } : {}),
    })
  }

  /** CLIP object-embedding detail → the object-embedding store (semantic
   *  search), under the model the RUNNER stamped — never a guess (D658). */
  private async routeClipDetail(
    deviceId: number,
    trackId: string,
    detail: DetailResult,
    timestamp: number,
  ): Promise<void> {
    const store = this.objectEmbeddingStore
    if (!store || detail.embedding === undefined) return
    // LINK the vector to the track's media. This path wrote neither key, and
    // since Phase-3 session-time dispatch it is the DOMINANT writer — measured
    // on the live hub, ZERO of 2,222 vectors on device 104 carried a media key,
    // including ones written minutes earlier. Two consequences: the documented
    // "a search hit's thumbnail IS the embedded crop" never happened (every hit
    // fell back to the event crop), and a vector whose events had been pruned
    // had no fallback render at all.
    //
    // Only `keyFrameMediaId` is available here: this path does not capture a
    // tight crop, so there is no `mediaKey` to link. That is enough — the key
    // frame is the full frame and can be rendered and re-boxed; the crop key is
    // set by the best-frame path when it runs.
    const keyFrameMediaId = this.residents.keyFrameMediaId(trackId)
    // The model that PRODUCED the vector, as the producing node stamped it from
    // the pool variant that ran — it decides the index (D649). A detail that
    // names none is refused by name inside the route; the old fallback to the
    // encoder's active model was the cluster row as a second process read it.
    await routeClipDetailToStore(store, {
      deviceId,
      trackId,
      timestamp,
      className: detail.className,
      score: detail.score,
      embeddingBase64: detail.embedding,
      embeddingModelId: detail.embeddingModelId,
      ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
    })
  }
}
