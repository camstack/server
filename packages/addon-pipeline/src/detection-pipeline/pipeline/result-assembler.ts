/**
 * ResultAssembler — converts per-step StepOutputs into the canonical
 * `FrameResult` shape consumed by every downstream surface (benchmark UI,
 * live view, analysis pipeline, notifications, event bus).
 *
 * Rules enforced here — see `@camstack/types/types/detection.ts` for the
 * full data model spec:
 *
 *   1. The executor walks the tree and hands each "root" output through
 *      `toMutableObjectDetection` to build a `MutableObjectDetection`.
 *   2. Child step outputs are routed via `applyChildOutput`:
 *        - classifier/embedding/text outputs add `ScoredLabel`s to the
 *          current detection's `labels[]` (own enrichments);
 *        - cropper outputs create NEW detail `MutableObjectDetection`
 *          entries that reference their parent via `parentId`;
 *        - refiner/mask outputs attach mask data to the parent's debug.
 *   3. After the whole tree is walked, `buildFrameResult` flattens:
 *        - first-level detections at root,
 *        - detail detections at root (with their `parentId` set),
 *      and inherits every detail's labels onto its parent (each carrying
 *      `detectionId = <detail id>`), so consumers can render a person's
 *      name directly from the root person entry.
 *   4. The assembler owns detection-id generation and the `originalClass`
 *      → macroClass mapping that the wiring service and postprocessor
 *      previously duplicated.
 *
 * The mutable intermediate keeps per-step latency / modelId maps so that
 * the final detection can surface them under `debug.stepLatencyMs` /
 * `debug.modelIds` when detection debug is enabled.
 */
import type {
  DetectionDebug,
  DiscardedDetection,
  FrameDebug,
  FrameResult,
  FrameStepTiming,
  MacroClass,
  ObjectDetection,
  ScoredLabel,
  StepOutput,
} from '@camstack/types'
import type { AbsoluteBbox } from './crop-utils.js'
import type { ExecutableStep } from './tree-builder.js'

/** L2 norm of a raw embedding vector. */
function vectorMagnitude(v: readonly number[]): number {
  let sum = 0
  for (const x of v) sum += x * x
  return Math.sqrt(sum)
}

// ---------------------------------------------------------------------------
// Mutable intermediate shapes (used only inside the executor; never leak)
// ---------------------------------------------------------------------------

/**
 * Mutable per-detection accumulator. One of these is created for every
 * root-level detection returned by a detector step, and for every detail
 * detection (face / plate) spawned by a cropper child. The executor
 * feeds per-step outputs into it via `applyChildOutput`, and the
 * assembler eventually converts them into immutable `ObjectDetection`s.
 */
export interface MutableObjectDetection {
  /** Unique id within the frame — `d1`, `d2`, … assigned sequentially by the executor. */
  id: string
  kind: 'first-level' | 'detail'
  /** Macro class carried at root (after classMap application). */
  macroClass: MacroClass
  /** Raw detector class before any macro mapping — populated on debug. */
  originalClass?: string
  /** Tier the RAW class may occupy as a label, from the root step (4g). */
  originalClassTier?: 1 | 2
  /** Score of the macro class itself (from the detector that emitted this). */
  score: number
  /** Absolute pixel coordinates [x1, y1, x2, y2] in the source frame. */
  bbox: AbsoluteBbox
  /** Id of the first-level parent when this is a detail entry. */
  parentId?: string
  /**
   * The ROOT model drew this box for a crop-kind step (D730): a per-frame
   * root child (a `license_plate` inside its vehicle), or a detail-plane root
   * fed by `suppliedRoot`. Its children read it with the root-box crop margin.
   */
  rootSupplied?: { readonly stepId: string; readonly modelId: string }
  /**
   * Facial landmarks (5 points) carried on a `face` detail produced by the
   * face detector. Used by the executor to align the crop before an embedding
   * step. Stored in crop-relative coordinates when first attached, then
   * transformed to absolute image space alongside `bbox`.
   */
  landmarks?: readonly { readonly x: number; readonly y: number }[]
  /** Own enrichment labels produced by classifier / recognizer / OCR steps. */
  ownLabels: ScoredLabel[]
  /** Top-N ranked candidates per source (classifier addon id → candidates). */
  alternateLabels: Record<string, readonly ScoredLabel[]>
  /** Per-step latency contributions on THIS detection. */
  stepLatencyMs: Record<string, number>
  /** Per-step model ids that touched THIS detection. */
  modelIds: Record<string, string>
  /** Extract mode of the detection's producing step (for debug). */
  extractMode?: 'full-frame' | 'crop-roi'
  /** Base64 binary segmentation mask attached by a seg/refiner step. */
  mask?: string
  maskWidth?: number
  maskHeight?: number
  /** Tight footprint box derived from the seg mask's largest component (absolute px tuple). */
  refinedBbox?: AbsoluteBbox
  /** Embedding id stored by a recognition step, when any. */
  embeddingId?: string
  /** Normalized face embedding stored by an arcface embedding step (the
   *  vector itself, not the opaque marker). Inherited to the parent in
   *  `buildFrameResult`. */
  embedding?: readonly number[]
  /** Model id of the embedding step that produced `embedding`. */
  embeddingModelId?: string
  /** L2 magnitude of the RAW pre-normalization vector — the face-quality signal
   *  normalizing `embedding` would otherwise destroy. */
  embeddingMagnitude?: number
  /** The EXACT landmark-aligned crop (base64 JPEG) the face-embedding step fed
   *  to the model for THIS face detail — the literal ArcFace input `embedding`
   *  was computed from. Set by the executor's aligned path (≥5 landmarks). Only
   *  on `face` details; NOT inherited onto the parent person. Emitted verbatim
   *  on the `ObjectDetection` so the gallery can show the true embedded crop. */
  faceAlignedCrop?: string
  /** Face short side (px) at NATIVE scale (`aligned.nativeFaceShortSidePx`).
   *  Carried so downstream min-face gates measure the real face, not the
   *  6×-downscaled detection-frame bbox (2026-07-22 native-gate fix). */
  nativeFaceShortSidePx?: number
}

// ---------------------------------------------------------------------------
// ID allocation
// ---------------------------------------------------------------------------

/**
 * Small deterministic id generator scoped to a single frame. Each call
 * returns the next `d{n}` id so detail parentId references can be set
 * at the time of creation.
 */
export class FrameIdGenerator {
  private counter = 0
  next(): string {
    this.counter += 1
    return `d${this.counter}`
  }
}

// ---------------------------------------------------------------------------
// Apply child step output to a parent detection
// ---------------------------------------------------------------------------

/**
 * Per-frame context passed to `applyChildOutput`:
 *   - `idGen`  — used to allocate ids for new detail entries
 *   - `details` — bucket where NEW detail `MutableObjectDetection`s are
 *                 pushed (cropper outputs). They'll be flattened at root
 *                 level by `buildFrameResult` after the walk finishes.
 *   - `parentStepLatencyMs` — partial latency map the executor fills
 *                             from `stepTimings` (so child enrichers can
 *                             add their ms here for the parent).
 */
export interface AssemblyContext {
  readonly idGen: FrameIdGenerator
  readonly details: MutableObjectDetection[]
  /**
   * Invoked when a classifier's CONFIDENT top-1 winner is removed by the class
   * filter (`enabledClasses` allow-list or `rejectClasses`) — dropped work,
   * which must never be silent (the 2026-08-21 sheep incident was diagnosed
   * blind because this branch left no trace). NOT invoked for a winner merely
   * under `minConfidence`: that is the normal uncertain case and the score
   * still rides the alternates. The executor wires this to a sampled log line
   * carrying `tags: { deviceId }`.
   */
  readonly onClassifierClassDropped?: (info: ClassifierClassDrop) => void
}

/** One confident classifier winner removed by the class filter. */
export interface ClassifierClassDrop {
  readonly stepId: string
  readonly modelId: string
  readonly droppedClass: string
  readonly score: number
  readonly reason: 'class-not-enabled' | 'reject-class'
}

/**
 * Apply a child step's output to its parent detection. Uses
 * `switch(output.kind)` for type-safe routing.
 *
 *   - detections + refiner slot  → mask attached to parent.debug
 *   - detections + cropper slot  → spawn detail MutableObjectDetection
 *                                  as a sibling at root level
 *   - classifications             → push ScoredLabels to parent.ownLabels,
 *                                   store alternates under addon id
 *   - embedding                   → push an opaque "embedding" label
 *   - text                        → push plate-OCR text as a ScoredLabel
 *   - mask                        → attach mask to parent.debug
 */
export function applyChildOutput(
  parent: MutableObjectDetection,
  childStep: ExecutableStep,
  output: StepOutput,
  stepLatencyMs: number,
  ctx: AssemblyContext,
): void {
  // Record per-detection step latency + modelId for debug panels.
  parent.stepLatencyMs[childStep.stepId] = stepLatencyMs
  parent.modelIds[childStep.stepId] = childStep.modelId

  switch (output.kind) {
    case 'detections': {
      // Refiner slot with mask data → attach best mask to parent.
      // Instance-segmentation models (YOLO-seg) output kind:'detections'
      // with per-instance masks. When running as a refiner child step,
      // pick the highest-confidence mask whose class maps to the parent's
      // macro class.
      if (childStep.definition.slot === 'refiner') {
        const classMap = childStep.effectiveClassMap?.mapping
        const parentMacro = parent.macroClass

        const candidates = output.detections.filter((d) => {
          if (d.mask === undefined) return false
          if (classMap) {
            const mapped = classMap[d.class]
            return mapped === parentMacro
          }
          return true
        })

        const best = candidates.toSorted((a, b) => b.score - a.score)[0]
        if (best?.mask !== undefined) {
          parent.mask = best.mask
          parent.maskWidth = best.maskWidth
          parent.maskHeight = best.maskHeight
        }
        break
      }

      // Cropper: each detection becomes a NEW detail entry at root
      // level, referencing `parent.id` as its parentId.
      for (const det of output.detections) {
        const detail: MutableObjectDetection = {
          id: ctx.idGen.next(),
          kind: 'detail',
          macroClass: mapCropperClassToDetailMacro(childStep.stepId, det.class),
          originalClass:
            det.class !== mapCropperClassToDetailMacro(childStep.stepId, det.class)
              ? det.class
              : undefined,
          score: det.score,
          bbox: det.bbox,
          parentId: parent.id,
          ownLabels: [],
          alternateLabels: {},
          stepLatencyMs: { [childStep.stepId]: stepLatencyMs },
          modelIds: { [childStep.stepId]: childStep.modelId },
          extractMode: 'crop-roi',
          ...(det.mask !== undefined
            ? { mask: det.mask, maskWidth: det.maskWidth, maskHeight: det.maskHeight }
            : {}),
          ...(det.landmarks !== undefined ? { landmarks: det.landmarks } : {}),
        }
        ctx.details.push(detail)
      }
      break
    }

    case 'classifications': {
      // Classifier / recognizer: attach all top-N candidates as own labels,
      // store the same set under alternateLabels[stepId] for debug compat.
      //
      // `minConfidence` is intentionally NOT applied here — threshold must
      // never gate label visibility. The operator reads the score on each
      // ScoredLabel; downstream consumers (alerts, tracking) apply their
      // own threshold. Raising the slider must never blank the candidates.
      //
      // `enabledClasses` (multiselect, optional): class allow-list — when
      // set to a non-empty array, keep only predictions whose class is in
      // the list. Empty / missing = all classes allowed.
      const rawEnabled = childStep.settings?.['enabledClasses']
      const enabledSet: ReadonlySet<string> | null =
        Array.isArray(rawEnabled) && rawEnabled.length > 0
          ? new Set(rawEnabled.filter((v): v is string => typeof v === 'string'))
          : null

      // Hard reject list (e.g. the AIY bird model's index-964 `background`
      // catch-all): a rejected class is NEVER emitted as a label OR an
      // alternate, so a `background` top-1 leaves the detection unclassified
      // rather than surfacing "background" as a species. Case-insensitive.
      const rejectSet: ReadonlySet<string> =
        childStep.definition.rejectClasses && childStep.definition.rejectClasses.length > 0
          ? new Set(childStep.definition.rejectClasses.map((c) => c.toLowerCase()))
          : new Set<string>()

      const passesClass = (c: { class: string; score: number }): boolean =>
        (enabledSet === null || enabledSet.has(c.class)) && !rejectSet.has(c.class.toLowerCase())

      // ownLabels: top-1 winner, gated by minConfidence threshold.
      // If the winner's score is below the threshold, no label is emitted
      // (the detection is "uncertain" — downstream consumers treat it as
      // unclassified). enabledClasses class allow-list also applies.
      // `output.classifications` is always top-1 after normalizeOutput.
      const minConfidence =
        typeof childStep.settings?.['minConfidence'] === 'number'
          ? (childStep.settings['minConfidence'] as number)
          : 0
      const winner = output.classifications[0]
      // Dropped-work visibility: a winner the operator's class filter removes
      // (allow-list or reject) is REPORTED, not swallowed — the detection keeps
      // its macro class and downstream sees "unclassified", which without this
      // hook is indistinguishable from "the classifier never fired".
      if (winner && !passesClass(winner) && winner.score >= minConfidence) {
        ctx.onClassifierClassDropped?.({
          stepId: childStep.stepId,
          modelId: childStep.modelId,
          droppedClass: winner.class,
          score: winner.score,
          reason:
            enabledSet !== null && !enabledSet.has(winner.class)
              ? 'class-not-enabled'
              : 'reject-class',
        })
      }
      if (winner && passesClass(winner) && winner.score >= minConfidence) {
        // 4g: the tier + attribution ride with the text. `labelTier` is read
        // from the step DEFINITION — a step that declares none produces a label
        // the persistence write rule refuses and logs, which is the intended
        // outcome: nothing downstream may infer a tier from this text.
        parent.ownLabels.push({
          label: winner.class,
          score: winner.score,
          ...(childStep.definition.labelTier !== undefined
            ? { tier: childStep.definition.labelTier }
            : {}),
          stepId: childStep.stepId,
          modelId: childStep.modelId,
        })
      }

      // alternateLabels: full top-N list — never gated by minConfidence so
      // the UI can always show all candidates and their scores even when the
      // threshold filters the winner out of labels[].
      const topN =
        output.alternates && output.alternates.length > 0
          ? output.alternates
          : output.classifications
      const allAlternates: ScoredLabel[] = topN
        .filter(passesClass)
        .map((cls) => ({ label: cls.class, score: cls.score }))
      if (allAlternates.length > 0) {
        parent.alternateLabels[childStep.stepId] = allAlternates
      }
      break
    }

    case 'embedding': {
      // Expose the normalized vector for downstream face recognition
      // (addon-post-analysis). Stored on the face detail; inherited to the
      // parent person in buildFrameResult.
      parent.embedding = output.embeddingNorm
      // `childStep.modelId` is the model of the pool variant that produced this
      // vector (`buildExecutableTree` takes it from the variant, D658) — never
      // a requested id, a cluster row or a cache.
      parent.embeddingModelId = childStep.modelId
      // Keep the RAW vector's magnitude. Normalizing destroys it, and it is the
      // only face-quality signal available for free: the postprocessor computes
      // both forms and, until 2026-08-19, this line was where the magnitude was
      // silently dropped. Consumers gate on it — see `embedding-magnitude-gate`.
      parent.embeddingMagnitude = vectorMagnitude(output.embedding)
      // Keep the opaque marker for back-compat — downstream label-utils
      // already filters `embedding:*` out of user-visible labels.
      parent.ownLabels.push({
        label: `embedding:${output.embedding.length}d`,
        score: 1.0,
      })
      break
    }

    case 'text': {
      // Skip empty/whitespace-only recognitions — the CTC postprocessor's
      // plausibility gate returns empty text for the degenerate low-resolution
      // collapse, and an empty plate label must never be stored.
      if (output.text.trim().length > 0) {
        parent.ownLabels.push({
          label: output.text,
          score: output.confidence,
          ...(childStep.definition.labelTier !== undefined
            ? { tier: childStep.definition.labelTier }
            : {}),
          stepId: childStep.stepId,
          modelId: childStep.modelId,
        })
      }
      break
    }

    case 'mask': {
      parent.mask = output.mask
      parent.maskWidth = output.maskWidth
      parent.maskHeight = output.maskHeight
      if (output.maskBbox !== undefined && output.maskWidth > 0 && output.maskHeight > 0) {
        const [px1, py1, px2, py2] = parent.bbox
        const parentW = px2 - px1
        const parentH = py2 - py1
        const [mbx, mby, mbw, mbh] = output.maskBbox
        parent.refinedBbox = [
          px1 + (mbx / output.maskWidth) * parentW,
          py1 + (mby / output.maskHeight) * parentH,
          px1 + ((mbx + mbw) / output.maskWidth) * parentW,
          py1 + ((mby + mbh) / output.maskHeight) * parentH,
        ]
      }
      break
    }
  }
}

/**
 * Map a cropper step's raw output class to a detail macro class.
 * e.g. `face-detection` → `'face'`, `plate-detection` → `'plate'`.
 * Falls back to the raw class if the step id doesn't match a known
 * detail detector.
 */
function mapCropperClassToDetailMacro(stepId: string, rawClass: string): MacroClass {
  if (stepId.includes('face')) return 'face'
  if (stepId.includes('plate')) return 'plate'
  return rawClass
}

// ---------------------------------------------------------------------------
// Build the final FrameResult
// ---------------------------------------------------------------------------

export interface BuildFrameResultInput {
  readonly deviceId: number
  readonly width: number
  readonly height: number
  /** First-level detections walked from root detector outputs. */
  readonly firstLevel: readonly MutableObjectDetection[]
  /** Detail detections spawned by cropper outputs (face / plate). */
  readonly details: readonly MutableObjectDetection[]
  /**
   * Discard trail collected by the executor's drop sites — always
   * populated when a drop happened. Undefined or empty ⇒ the field is
   * omitted from the FrameResult entirely — absent means "nothing
   * dropped", never an empty array on the wire.
   */
  readonly discarded?: readonly DiscardedDetection[]
  /**
   * Root-shed marker: present when the pool DELIBERATELY skipped at least
   * one ROOT step of this frame under overload (`EngineOutput.dropped`).
   * Emitted as `shed: true` + `shedReason` on the FrameResult so consumers
   * can count sheds without inferring them from an empty detections array.
   * Absent ⇒ every root step actually ran; no field on the wire.
   */
  readonly shed?: { readonly reason: string }
  readonly stepTimings: readonly FrameStepTiming[]
  readonly totalMs: number
  readonly engine: string
  readonly pipelineId?: string
  /** When true, populates the `debug` field on both frame and detection level. */
  readonly debug: boolean
  /** Aggregated python-pool stage timings across all steps. Surfaces preprocess vs predict split for benchmarking. */
  readonly poolTimings?: {
    readonly preprocessMs: number
    readonly predictMs: number
    readonly batchSize: number
  }
  /** Wall-clock timestamp of frame capture / emission. */
  readonly timestamp: number
  /** Optional frame id override — the assembler generates a UUID-ish default if omitted. */
  readonly frameId?: string
}

export function buildFrameResult(input: BuildFrameResultInput): FrameResult {
  // Index details by parentId so we can inherit their labels onto the
  // first-level entries before emitting.
  const detailsByParent = new Map<string, MutableObjectDetection[]>()
  for (const detail of input.details) {
    if (!detail.parentId) continue
    const arr = detailsByParent.get(detail.parentId) ?? []
    arr.push(detail)
    detailsByParent.set(detail.parentId, arr)
  }

  const toImmutableObject = (m: MutableObjectDetection): ObjectDetection => {
    // Compose labels: own enrichments first, then inherited from details.
    const labels: ScoredLabel[] = [...m.ownLabels]
    const children = detailsByParent.get(m.id) ?? []
    for (const child of children) {
      for (const childLabel of child.ownLabels) {
        // Inheriting copies the tier + attribution UNCHANGED: the tier belongs
        // to the step that decided the text, not to the parent that carries it.
        labels.push({
          label: childLabel.label,
          score: childLabel.score,
          detectionId: child.id,
          ...(childLabel.tier !== undefined ? { tier: childLabel.tier } : {}),
          ...(childLabel.stepId !== undefined ? { stepId: childLabel.stepId } : {}),
          ...(childLabel.modelId !== undefined ? { modelId: childLabel.modelId } : {}),
        })
      }
    }

    // Effective embedding: a detection's own (the face detail arcface ran on),
    // else inherited from its best (highest-score) embedding-bearing child
    // (the parent person inherits its face's vector — same child→parent flow
    // as labels). One face per parent in practice; ties resolve to the first.
    let embedding = m.embedding
    let embeddingModelId = m.embeddingModelId
    if (embedding === undefined) {
      let best: MutableObjectDetection | undefined
      for (const child of children) {
        if (child.embedding === undefined) continue
        if (best === undefined || child.score > best.score) best = child
      }
      if (best !== undefined) {
        embedding = best.embedding
        embeddingModelId = best.embeddingModelId
      }
    }

    const bbox = bboxTupleToRect(m.bbox)

    const base: ObjectDetection = {
      id: m.id,
      kind: m.kind,
      macroClass: m.macroClass,
      score: m.score,
      bbox,
      ...(m.refinedBbox !== undefined ? { refinedBbox: bboxTupleToRect(m.refinedBbox) } : {}),
      ...(m.mask !== undefined && m.maskWidth !== undefined && m.maskHeight !== undefined
        ? { mask: m.mask, maskWidth: m.maskWidth, maskHeight: m.maskHeight }
        : {}),
      labels,
      ...(m.parentId !== undefined ? { parentId: m.parentId } : {}),
      ...(m.rootSupplied !== undefined ? { rootSupplied: m.rootSupplied } : {}),
      ...(embedding !== undefined
        ? {
            embedding,
            ...(embeddingModelId !== undefined ? { embeddingModelId } : {}),
          }
        : {}),
      // The aligned crop is the exact ArcFace input for THIS face detail; carry
      // it verbatim (no parent inheritance — the person box is not the input).
      ...(m.faceAlignedCrop !== undefined ? { faceAlignedCrop: m.faceAlignedCrop } : {}),
      ...(m.nativeFaceShortSidePx !== undefined
        ? { nativeFaceShortSidePx: m.nativeFaceShortSidePx }
        : {}),
      // The detection's OWN landmarks (a face), in the same space as `bbox`
      // (D644) — kept beside the face's source frame downstream. Never
      // inherited onto a parent: a person box has no landmarks of its own.
      ...(m.landmarks !== undefined ? { landmarks: m.landmarks } : {}),
    }

    if (input.debug) {
      const debug: DetectionDebug = {
        stepLatencyMs: Object.keys(m.stepLatencyMs).length > 0 ? { ...m.stepLatencyMs } : undefined,
        modelIds: Object.keys(m.modelIds).length > 0 ? { ...m.modelIds } : undefined,
        extractMode: m.extractMode,
        originalClass: m.originalClass,
        originalClassTier: m.originalClassTier,
        alternateLabels:
          Object.keys(m.alternateLabels).length > 0 ? { ...m.alternateLabels } : undefined,
        mask: m.mask,
        maskWidth: m.maskWidth,
        maskHeight: m.maskHeight,
        embeddingId: m.embeddingId,
      }
      // Strip undefined keys so the payload stays clean when the section
      // has nothing meaningful to report. We project into a Record first
      // because `DetectionDebug` is a strict interface with no index
      // signature, so `pruneUndefined<DetectionDebug>` can't type-check.
      const asRecord: Record<string, unknown> = { ...debug }
      const cleanDebug = pruneUndefined(asRecord) as DetectionDebug
      if (Object.keys(cleanDebug).length > 0) {
        return { ...base, debug: cleanDebug }
      }
    }
    return base
  }

  const detections: ObjectDetection[] = []
  for (const d of input.firstLevel) detections.push(toImmutableObject(d))
  for (const d of input.details) detections.push(toImmutableObject(d))

  // Frame-level debug (totalInferenceMs, stepTimings, engine, pipelineId)
  // is always populated because the metrics it carries are cheap and
  // downstream consumers (benchmark UI, metrics dashboard, e2e tests,
  // runner timing sampler) rely on them on every frame. The `input.debug`
  // flag above still gates per-detection verbose fields (alternateLabels,
  // mask, stepLatencyMs, …) which ARE expensive and should only be
  // emitted in full-verbosity trace mode.
  const frameDebug: FrameDebug = {
    totalInferenceMs: input.totalMs,
    stepTimings: input.stepTimings,
    engine: input.engine,
    pipelineId: input.pipelineId,
    ...(input.poolTimings
      ? {
          preprocessMs: input.poolTimings.preprocessMs,
          predictMs: input.poolTimings.predictMs,
          batchSize: input.poolTimings.batchSize,
        }
      : {}),
  }

  return {
    kind: 'frame',
    frameId: input.frameId ?? generateFrameId(),
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    width: input.width,
    height: input.height,
    detections,
    ...(input.discarded !== undefined && input.discarded.length > 0
      ? { discarded: input.discarded }
      : {}),
    ...(input.shed !== undefined ? { shed: true as const, shedReason: input.shed.reason } : {}),
    debug: frameDebug,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bboxTupleToRect(bbox: AbsoluteBbox): {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
} {
  const [x1, y1, x2, y2] = bbox
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      ;(out as Record<string, unknown>)[k] = v
    }
  }
  return out
}

function generateFrameId(): string {
  return `frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Seed a MutableObjectDetection from a root-level detector output. */
export function toMutableRootDetection(
  det: {
    readonly class: string
    readonly score: number
    readonly bbox: readonly [number, number, number, number]
    readonly landmarks?: readonly { readonly x: number; readonly y: number }[]
    readonly mask?: string
    readonly maskWidth?: number
    readonly maskHeight?: number
  },
  rootStep: ExecutableStep,
  idGen: FrameIdGenerator,
  rootStepLatencyMs: number,
): MutableObjectDetection {
  return {
    id: idGen.next(),
    kind: 'first-level',
    macroClass: det.class,
    originalClass: det.class,
    // 4g: the tier the raw class may occupy, DECLARED by the root step. Carried
    // beside the value it qualifies so the consumer never has to guess.
    ...(rootStep.definition.labelTier !== undefined
      ? { originalClassTier: rootStep.definition.labelTier }
      : {}),
    score: det.score,
    bbox: [...det.bbox] as AbsoluteBbox,
    ownLabels: [],
    alternateLabels: {},
    stepLatencyMs: { [rootStep.stepId]: rootStepLatencyMs },
    modelIds: { [rootStep.stepId]: rootStep.modelId },
    extractMode: 'full-frame',
    ...(det.mask !== undefined
      ? { mask: det.mask, maskWidth: det.maskWidth, maskHeight: det.maskHeight }
      : {}),
    // Carry engine landmarks onto the root detection exactly as the
    // cropper-spawned detail path does (mirror the attach above). When a
    // `face-detection` step is promoted to a subtree ROOT (runDetailSubtree),
    // its detections must keep the 5 keypoints so the face-embedding child
    // can align the ArcFace crop instead of falling back to a plain crop.
    ...(det.landmarks !== undefined ? { landmarks: det.landmarks } : {}),
  }
}
