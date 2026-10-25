/**
 * The enrichment fan-out — a classifier / plate-OCR answer onto the track's
 * tiered label, and the new-best CLIP tracks onto the object-embedding store
 * with their tight crop. Moved out of `pipeline-analytics/index.ts` verbatim
 * (Plan B, extraction 3): only the visibility of the entry points changed.
 * Every dependency is read through the deps object — getters for what the
 * addon opens in `onInitialize`.
 */
import { type AddonContext, type DetailResult, errMsg, type FrameHandle } from '@camstack/types'
import { ENRICHMENT_CAPTURE_STALE_MS } from '../media/capture-timing.js'
import {
  type ApplyTrackLabelResult,
  applyTrackLabelCandidate,
} from '../pipeline/apply-track-label.js'
import type { CaptureCropFn } from '../pipeline/capture-crop.js'
import type { TrackedDetectionOut } from '../pipeline/frame-processor.js'
import { isClipObjectEmbedding } from '../pipeline/object-embedding-selection.js'
import type { TrackResidentState } from '../pipeline/track-resident-state.js'
import { captureCoalesceKey, type CaptureScheduler } from '../runtime/capture-scheduler.js'
import type { EventStore } from '../store/event-store.js'
import type { MediaStore } from '../store/media-store.js'
import type { ObjectEmbeddingStore } from '../store/object-embedding-store.js'
import type { TrackStore } from '../store/track-store.js'

/** What the fan-out reads from the addon. */
export interface EnrichmentFanoutDeps {
  /** The addon context — throws outside the initialized window. */
  readonly ctx: () => AddonContext
  readonly residents: TrackResidentState
  readonly captureScheduler: () => CaptureScheduler
  readonly trackStore: () => TrackStore | null
  readonly eventStore: () => EventStore | null
  readonly mediaStore: () => MediaStore | null
  readonly objectEmbeddingStore: () => ObjectEmbeddingStore | null
  readonly captureCrop: () => CaptureCropFn | null
}

export class EnrichmentFanout {
  constructor(private readonly deps: EnrichmentFanoutDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get residents(): TrackResidentState {
    return this.deps.residents
  }

  private get captureScheduler(): CaptureScheduler {
    return this.deps.captureScheduler()
  }

  private get trackStore(): TrackStore | null {
    return this.deps.trackStore()
  }

  private get eventStore(): EventStore | null {
    return this.deps.eventStore()
  }

  private get mediaStore(): MediaStore | null {
    return this.deps.mediaStore()
  }

  private get objectEmbeddingStore(): ObjectEmbeddingStore | null {
    return this.deps.objectEmbeddingStore()
  }

  private get captureCrop(): CaptureCropFn | null {
    return this.deps.captureCrop()
  }

  /**
   * A classifier / plate-OCR answer → the track's tiered label (TrackStore +
   * persisted events + importance).
   *
   * The TIER is the step's, carried on the wire as `DetailResult.labelTier`;
   * this path never derives one. A detail from a step that declares no tier is
   * refused and logged by the write rule — which is the intended behaviour on
   * a runner older than the declaration, because the alternative is guessing
   * and putting a species in the coarse slot.
   */
  async applyTrackEnrichmentLabel(
    deviceId: number,
    trackId: string,
    label: string,
    detail: DetailResult,
    decidedAt: number,
    identityId?: string,
  ): Promise<ApplyTrackLabelResult> {
    return applyTrackLabelCandidate(
      {
        ...(this.trackStore ? { trackStore: this.trackStore } : {}),
        ...(this.eventStore ? { eventStore: this.eventStore } : {}),
        logger: this.ctx.logger,
      },
      deviceId,
      trackId,
      {
        text: label,
        ...(detail.labelTier !== undefined ? { tier: detail.labelTier } : {}),
        score: detail.score,
        stepId: detail.stepId,
        ...(detail.labelModelId !== undefined ? { modelId: detail.labelModelId } : {}),
        decidedAt,
        ...(identityId !== undefined ? { identityId } : {}),
      },
    )
  }

  /**
   * Capture the tight object crop for each new-best CLIP track (native-res via
   * the shared extractor) and upsert the embedding row with that crop's media
   * key. The crop uses `putReplacing` so exactly ONE object crop is kept per
   * track (the current peak). The embedding is upserted even when no crop was
   * captured (no frame handle) so semantic search still works — the crop just
   * enhances the search-hit thumbnail. `upsertIfBetter` remains the durable
   * cross-restart best gate (R3). Best-effort; issued in the live-frame window.
   */
  async persistObjectEmbeddingBests(
    deviceId: number,
    timestamp: number,
    bests: readonly TrackedDetectionOut[],
    frameHandle: FrameHandle | undefined,
    frameWidth: number,
    frameHeight: number,
    cropPadding: number,
  ): Promise<void> {
    const store = this.objectEmbeddingStore
    if (!store) return
    await Promise.all(
      bests.map(async (t) => {
        if (!isClipObjectEmbedding(t)) return
        let mediaId: number | undefined
        const captureCrop = this.captureCrop
        if (frameHandle !== undefined && captureCrop && this.mediaStore) {
          try {
            // S4: scheduler-routed — kind 'embed' (enrichment rung), coalesced
            // per track (a re-fire for a track whose best-crop capture is
            // still in flight JOINS it), stale-dropped once the handle's
            // retained surface is gone. A `null` skips the media key exactly
            // like the pre-S4 native miss.
            const crop = await this.captureScheduler.request({
              deviceId,
              trackId: t.trackId,
              kind: 'embed',
              coalesceKey: captureCoalesceKey(deviceId, 'embed', t.trackId),
              staleAfterMs: ENRICHMENT_CAPTURE_STALE_MS,
              exec: () => captureCrop(frameHandle, t.bbox, frameWidth, frameHeight, cropPadding),
            })
            if (crop) {
              mediaId = await this.mediaStore.putReplacing({
                deviceId,
                ownerKind: 'track',
                ownerId: t.trackId,
                kind: 'crop',
                timestamp,
                data: crop,
              })
            }
          } catch (err) {
            this.ctx.logger.debug('object-embedding crop capture failed', {
              tags: { deviceId },
              meta: { trackId: t.trackId, error: errMsg(err) },
            })
          }
        }
        // Design B: LINK this embedding row to the track's shared native key
        // frame (captured by the general best-frame path — `persistKeyFrames`).
        // Best-effort: absent until the track's first best-frame capture lands.
        const keyFrameMediaId = this.residents.keyFrameMediaId(t.trackId)
        await store.upsertIfBetter({
          trackId: t.trackId,
          deviceId,
          timestamp,
          className: t.className,
          embedding: t.embedding,
          modelId: t.embeddingModelId,
          confidence: t.confidence,
          ...(mediaId !== undefined ? { mediaId } : {}),
          ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
        })
      }),
    )
  }
}
