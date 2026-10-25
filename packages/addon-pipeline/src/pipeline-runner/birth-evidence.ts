/**
 * WHICH boxes of a finished frame get their own pixels cut, and where from —
 * the runner's half of the carried birth evidence (D379).
 *
 * ## Why this is a decision and not a `map`
 *
 * The gate's question ("is this really a person, or a wall?") needs pixels of
 * the box. Asking for them AFTERWARDS, by handle, across a process boundary,
 * was measured over three hours on the live hub and does not work: 7 452 native
 * crop misses, 99.9% `worker-lease-gone`, at a median handle age of 1 347 ms
 * with misses recorded as early as 254 ms — the frame is very often never
 * retained at all, so no eviction window and no registry partition can help.
 * 1 191 of 1 883 gate verdicts (63%) never saw a pixel.
 *
 * So the cut happens where the pixels already are. The cost of that is paid on
 * the frame path, which is why this module exists: a frame that detects twelve
 * subjects must not turn into twelve JPEG encodes. Only a box the camera has
 * NOT seen recently is worth an encode, because only such a box can become a
 * birth — and a birth is rare against a frame.
 *
 * ## What this is NOT
 *
 * Not a crop derivation for a model input. `deriveDetailCropRect` remains the
 * only place a detail/CLIP rectangle is computed (D52) and is not reachable
 * from here; the rectangle below is a detection box padded for a CLASSIFICATION
 * question, fed to a re-detector and to nothing else — never embedded, never
 * stored as media, never indexed. It is also not the recovery crop of D372,
 * which starts from a motion region before any subject exists.
 *
 * Pure: no pixels, no IPC, no runner state beyond the memory the caller owns.
 */

/** A rectangle in absolute pixels of the analysis frame. */
export interface EvidenceRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The frame the candidates were measured against. */
export interface EvidenceFrameDims {
  readonly width: number
  readonly height: number
}

/** The minimal shape of a detection this planner reads. */
export interface EvidenceCandidate {
  /** Absolute pixels of the analysis frame (`DetectionBoundingBox`). */
  readonly bbox: EvidenceRect
  /** The macro class's own score, as the detector emitted it. */
  readonly score: number
  /** Coarse class. Novelty is judged per class — see {@link BirthNoveltyMemory}. */
  readonly macroClass: string
}

/** One planned cut: which detection, from where, at what size. */
export interface EvidencePlanEntry {
  /** Index into the detections array the caller passed. */
  readonly index: number
  /** The padded, clamped source rectangle in analysis-frame pixels. */
  readonly rect: EvidenceRect
  /** The size the JPEG is encoded at — capped, aspect-preserving, never upscaled. */
  readonly target: { readonly width: number; readonly height: number }
}

/**
 * Overlap at or above which a box counts as "the same subject the camera is
 * already showing". 0.3 is the tracker's own `iouThreshold`: a box the tracker
 * would associate to an existing track cannot be a birth, so cutting its pixels
 * buys nothing.
 */
export const BIRTH_EVIDENCE_NOVELTY_IOU = 0.3

/**
 * How long a box stays "seen".
 *
 * Sized on the gate's own clock, not on a guess: `maxDeferralMs` defaults to
 * 2 000 ms, so a birth's whole life as a candidate is 2 s. A window shorter
 * than that would re-cut the same subject inside one deferral; a much longer
 * one would stop a subject that genuinely left and returned from being cut
 * again. 3 000 ms is the deferral budget plus one 1 s margin.
 */
export const BIRTH_EVIDENCE_NOVELTY_WINDOW_MS = 3_000

/**
 * Most cuts on ONE frame.
 *
 * The bound exists because the encode sits between the inference result and the
 * emit. Measured need: over three hours the busiest camera (`hall`) produced
 * 363 gate verdicts, i.e. 2.0 births/min — two per frame is already an order of
 * magnitude above what any measured frame asks for, and it is what keeps a
 * crowd walking into view from becoming twelve encodes on one frame.
 */
export const BIRTH_EVIDENCE_MAX_PER_FRAME = 2

/**
 * Padding around the box, as a fraction of its size.
 *
 * 0.15 deliberately equals `CONFIRMATION_CROP_PADDING` in post-analysis: the
 * gate promotes a secondary subject by mapping a crop-space box back into the
 * frame through the rectangle the crop was cut from, and the two derivations
 * disagreeing is how a promoted box lands somewhere the pixels never were.
 */
export const BIRTH_EVIDENCE_PADDING = 0.15

/**
 * Widest evidence JPEG. Equals `CONFIRMATION_CROP_MAX_WIDTH` (320) — the size
 * the gate's re-detector has always been fed. A crop this size is ~10-20 kB, so
 * two of them on a frame are a few tens of kilobytes on an event that already
 * carries a frame result: small enough to cross a boundary, which a frame at
 * frame rate is not (D9/D18).
 */
export const BIRTH_EVIDENCE_MAX_WIDTH = 320

/**
 * Shortest side worth an encode, in analysis-frame pixels.
 *
 * NOT the gate's `minCropPx` (48). That floor answers "is the box worth a
 * verdict at all"; this one answers "is this crop a MEASUREMENT". D377 measured
 * the difference: a ~130 px blob letterboxed into the detector's 320 px input,
 * with no context, is "a third, different, worse image" whose verdict was a coin
 * flip on the same subject two frames apart. Below this floor the carried crop
 * would cost an inference and then escalate to the native path anyway, so the
 * encode buys nothing.
 *
 * 128 is that measured coin-flip size, taken as a floor rather than a target.
 */
export const BIRTH_EVIDENCE_MIN_PX = 128

/** JPEG quality. This is a DETECTOR INPUT, not a preview. */
export const BIRTH_EVIDENCE_JPEG_QUALITY = 85

/**
 * Boxes remembered per camera. A frame with more subjects than this keeps the
 * most recent — the cap is about bounding a crowd, and a box that fell out is
 * merely eligible for a cut it will not get twice (the encode budget above is
 * the real spend). 64 is 16x the tile tier's per-frame subject cap.
 */
const REMEMBERED_BOXES_PER_DEVICE = 64

/** One remembered box: enough to answer "have I seen this subject lately?". */
interface RememberedBox {
  readonly rect: EvidenceRect
  readonly macroClass: string
  readonly atMs: number
}

/** What {@link BirthNoveltyMemory.note} is told about a frame's detections. */
export interface NotedDetection {
  readonly bbox: EvidenceRect
  readonly macroClass: string
}

/**
 * Per-camera memory of the boxes recently on screen.
 *
 * Per CAMERA and never global: a box on 102 says nothing about 101, and a
 * shared structure would make one camera's traffic decide another's cuts —
 * which is the exact shape of the node-wide sharing this whole change moves
 * away from.
 *
 * Judged per CLASS. A dog at its owner's knee is 100% contained in the person's
 * box; a class-blind test would call it "already seen" and it would reach the
 * gate with no pixels — the failure D372, D377 and D378 each fought at a
 * different layer.
 */
export class BirthNoveltyMemory {
  private readonly byDevice = new Map<number, RememberedBox[]>()

  /**
   * Is this box a subject the camera has not been showing?
   *
   * Pure: it does not record anything. The caller records the whole frame with
   * {@link note}, once, so a box that lost the encode budget is still counted
   * as seen — otherwise the cap turns into a permanent re-cut of the same
   * subjects.
   */
  isNovel(deviceId: number, box: EvidenceRect, macroClass: string, nowMs: number): boolean {
    const boxes = this.byDevice.get(deviceId)
    if (!boxes) return true
    for (const remembered of boxes) {
      if (nowMs - remembered.atMs > BIRTH_EVIDENCE_NOVELTY_WINDOW_MS) continue
      if (remembered.macroClass !== macroClass) continue
      if (iou(remembered.rect, box) >= BIRTH_EVIDENCE_NOVELTY_IOU) return false
    }
    return true
  }

  /** Record a frame's detections and drop everything past the window / the cap. */
  note(deviceId: number, detections: readonly NotedDetection[], nowMs: number): void {
    const previous = this.byDevice.get(deviceId) ?? []
    const kept = previous.filter((b) => nowMs - b.atMs <= BIRTH_EVIDENCE_NOVELTY_WINDOW_MS)
    for (const d of detections) {
      if (!isUsable(d.bbox)) continue
      kept.push({ rect: d.bbox, macroClass: d.macroClass, atMs: nowMs })
    }
    // Newest wins when the cap bites: the oldest entries are the ones the
    // window is about to drop anyway.
    this.byDevice.set(
      deviceId,
      kept.length > REMEMBERED_BOXES_PER_DEVICE
        ? kept.slice(kept.length - REMEMBERED_BOXES_PER_DEVICE)
        : kept,
    )
  }

  /** How many boxes this camera currently remembers (tests / diagnostics). */
  rememberedCount(deviceId: number): number {
    return this.byDevice.get(deviceId)?.length ?? 0
  }

  /** Forget a camera wholesale (detach, pipeline reset). */
  clearDevice(deviceId: number): void {
    this.byDevice.delete(deviceId)
  }
}

/**
 * The cuts worth taking on this frame, highest confidence first, capped.
 *
 * Records EVERY usable detection in `memory` — including the ones the cap
 * refused — so the budget bounds the spend without turning into a leak.
 */
export function planBirthEvidence(
  deviceId: number,
  detections: readonly EvidenceCandidate[],
  frame: EvidenceFrameDims,
  memory: BirthNoveltyMemory,
  nowMs: number,
  maxPerFrame: number = BIRTH_EVIDENCE_MAX_PER_FRAME,
): readonly EvidencePlanEntry[] {
  if (frame.width <= 0 || frame.height <= 0) return []
  const usable = detections.map((d, index) => ({ d, index })).filter(({ d }) => isUsable(d.bbox))
  const novel = usable.filter(({ d }) => memory.isNovel(deviceId, d.bbox, d.macroClass, nowMs))
  memory.note(
    deviceId,
    usable.map(({ d }) => ({ bbox: d.bbox, macroClass: d.macroClass })),
    nowMs,
  )
  const plan: EvidencePlanEntry[] = []
  for (const { d, index } of [...novel].sort((a, b) => b.d.score - a.d.score)) {
    if (plan.length >= maxPerFrame) break
    const rect = padAndClamp(d.bbox, frame)
    if (rect === null) continue
    plan.push({ index, rect, target: targetFor(rect) })
  }
  // Back into detection order: the caller indexes its own array with these and
  // a score-ordered plan makes that read wrong at a glance.
  return plan.sort((a, b) => a.index - b.index)
}

/**
 * The padded, clamped source rectangle — or `null` for a box that is not worth
 * an encode. A degenerate box is DROPPED rather than clamped: a zero-area crop
 * serves nothing and a NaN one would poison the encoder's geometry.
 */
function padAndClamp(box: EvidenceRect, frame: EvidenceFrameDims): EvidenceRect | null {
  if (Math.min(box.width, box.height) < BIRTH_EVIDENCE_MIN_PX) return null
  const padX = box.width * BIRTH_EVIDENCE_PADDING
  const padY = box.height * BIRTH_EVIDENCE_PADDING
  const left = Math.max(0, Math.floor(box.x - padX))
  const top = Math.max(0, Math.floor(box.y - padY))
  const right = Math.min(frame.width, Math.ceil(box.x + box.width + padX))
  const bottom = Math.min(frame.height, Math.ceil(box.y + box.height + padY))
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) return null
  return { x: left, y: top, width, height }
}

/** Encoded size: capped, aspect-preserving, never upscaled. */
function targetFor(rect: EvidenceRect): { readonly width: number; readonly height: number } {
  if (rect.width <= BIRTH_EVIDENCE_MAX_WIDTH) return { width: rect.width, height: rect.height }
  const scale = BIRTH_EVIDENCE_MAX_WIDTH / rect.width
  return {
    width: BIRTH_EVIDENCE_MAX_WIDTH,
    height: Math.max(1, Math.round(rect.height * scale)),
  }
}

/** A box with finite, positive extent. */
function isUsable(box: EvidenceRect): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  )
}

/** Intersection over union of two absolute-pixel rectangles. */
function iou(a: EvidenceRect, b: EvidenceRect): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const w = right - left
  const h = bottom - top
  if (w <= 0 || h <= 0) return 0
  const intersection = w * h
  const union = a.width * a.height + b.width * b.height - intersection
  return union <= 0 ? 0 : intersection / union
}
