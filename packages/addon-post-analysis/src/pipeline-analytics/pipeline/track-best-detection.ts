/**
 * `TrackBestSelector` — the ONE unified "best detection per track" primitive.
 *
 * Post-analysis derives several per-track "best" artefacts (best FRAME thumbnail,
 * best OBJECT/CLIP embedding + its crop, best FACE crop). They all rank the same
 * way: highest detector confidence per `trackId`. This selector composes the
 * canonical {@link BestDetectionTracker} ranking with the RESOLVED payload the
 * consumers need at the peak (bbox / className / embedding / faceBbox), so a
 * single "new best" DECISION can drive one capture whose output is shared:
 *  - the boxed best-frame `thumbnail`,
 *  - the tight object crop written onto the CLIP embedding row's `mediaId`
 *    (so a search hit's thumbnail IS the embedded crop).
 *
 * It is deliberately in-memory (the peak is per live track, dropped at track
 * end). The CLIP embedding's cross-restart persistence stays a SEPARATE store-
 * side gate (`ObjectEmbeddingStore.upsertIfBetter`): this selector unifies the
 * DECISION, not the durable store (see best-detection-tracker.ts docstring).
 *
 * The face path keeps its own hold buffer because a face crop can only come
 * from a face-bearing frame (the documented FRAME↔FACE seam) — but it shares
 * this ranking so best-frame and best-face agree on which frame is "best".
 */

import { BestDetectionTracker, type BestDetectionTrackerOptions } from './best-detection-tracker.js'
import { renameKey } from './tracker-v2/rename.js'

export interface PixelBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The resolved best payload held for a track (excludes `trackId`, which is the
 *  map key). Everything a downstream capture / upsert needs at the peak frame. */
export interface TrackBestPayload {
  readonly confidence: number
  readonly atMs: number
  readonly className: string
  readonly bbox: PixelBox
  readonly embedding?: readonly number[]
  readonly embeddingModelId?: string
  readonly faceBbox?: PixelBox
}

/** A single observation fed to the selector — a tracked detection this frame. */
export interface TrackBestObservation extends TrackBestPayload {
  readonly trackId: string
}

export type TrackBestSelectorOptions = BestDetectionTrackerOptions

export class TrackBestSelector {
  private readonly tracker: BestDetectionTracker
  private readonly payloads = new Map<string, TrackBestPayload>()

  constructor(options: TrackBestSelectorOptions = {}) {
    this.tracker = new BestDetectionTracker(options)
  }

  /**
   * Record an observation for its track. Returns true when it becomes the
   * track's new best (first sighting, or a confidence that beats the held peak
   * per the tracker's hysteresis / minGap rules). On acceptance the held payload
   * advances to this observation so `peak(trackId)` returns the winning frame's
   * bbox / embedding / faceBbox.
   */
  observe(obs: TrackBestObservation): boolean {
    const isNewBest = this.tracker.observe(obs.trackId, obs.confidence, obs.atMs)
    if (isNewBest) {
      const { trackId, ...payload } = obs
      this.payloads.set(trackId, payload)
    }
    return isNewBest
  }

  /** The held best payload for a track (undefined if never observed). */
  peak(trackId: string): TrackBestPayload | undefined {
    return this.payloads.get(trackId)
  }

  /** The held peak confidence for a track (undefined if never observed). */
  peakConfidence(trackId: string): number | undefined {
    return this.tracker.peak(trackId)?.confidence
  }

  /**
   * D683: fold the absorbed track's peak into the survivor's — the SAME
   * ranking verdict {@link BestDetectionTracker.adopt} reaches, applied here
   * to the resolved payload (bbox / className / embedding / faceBbox) too.
   * Deliberate (review L6): the full `compareBestFrame` verdict with this
   * policy's hysteresis, not a bare "higher `peakConfidence`" — for the
   * confidence-only CLIP policy the two only differ inside the hysteresis
   * band, where the earlier (survivor's) peak is kept.
   */
  adopt(survivorId: string, absorbedId: string): void {
    const winner = this.tracker.adopt(survivorId, absorbedId)
    if (winner === 'absorbed') renameKey(this.payloads, absorbedId, survivorId)
    else this.payloads.delete(absorbedId)
  }

  /** Drop a track's peak + payload (call at track end). */
  delete(trackId: string): void {
    this.tracker.delete(trackId)
    this.payloads.delete(trackId)
  }

  clear(): void {
    this.tracker.clear()
    this.payloads.clear()
  }
}
