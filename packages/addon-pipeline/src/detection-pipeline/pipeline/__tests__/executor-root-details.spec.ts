/**
 * Task 6b — root-level classifier/embedding outputs yield synthesized
 * full-frame details.
 *
 * `pipelineRunner.runDetailSubtree` promotes a subtree's first step to a
 * ROOT in a `plane:'full'` `PipelineExecutor.run()` call so it can run on a
 * single tracked crop. That works for detector-shaped chains (their root
 * output is `kind:'detections'`), but a step whose output is a
 * classification or embedding — `clip-embedding`, `animal-classifier`,
 * `bird-classifier`, `vehicle-classifier` — was silently dropped: the root
 * loop `continue`d on `rootOutput.kind !== 'detections'`.
 *
 * These specs assert the executor now synthesizes ONE full-frame detection
 * for a non-detector root and attaches the classification/embedding to it
 * via the SAME `applyChildOutput` path `executeChildren` uses for a normal
 * child — so a subtree-root run is indistinguishable from the step running
 * as a child of `object-detection`.
 */
import { describe, it, expect, vi } from 'vitest'
import sharp from 'sharp'
import type {
  EngineOutput,
  IInferenceEngine,
  InferenceInput,
  ModelCatalogEntry,
  StepDefinition,
} from '@camstack/types'
import { PipelineExecutor } from '../executor.js'
import { FrameIdGenerator, toMutableRootDetection } from '../result-assembler.js'
import type { ExecutableStep, ExecutableTree } from '../tree-builder.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRAME_WIDTH = 120
const FRAME_HEIGHT = 90

function makeModelEntry(id: string): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: '',
    formats: {},
    inputSize: { width: 64, height: 64 },
    labels: [],
  }
}

/**
 * A classifier step definition scoped exactly like the real
 * `animal-classifier` — `slot:'classifier'`, `inputClasses` non-null (it's
 * normally a CHILD of object-detection), which `runDetailSubtree` promotes
 * to a subtree ROOT so it runs directly on the tracked crop.
 */
const classifierRootDefinition: StepDefinition = {
  id: 'test-animal-classifier',
  name: 'Test Animal Classifier',
  slot: 'classifier',
  postprocessor: 'softmax',
  extractMode: 'crop-roi',
  inputClasses: ['animal'],
  outputClasses: ['animal-type'],
  models: [makeModelEntry('stub-classifier-model')],
  defaultModelId: 'stub-classifier-model',
  defaultConfidence: 0.2,
}

/**
 * An embedding step definition scoped exactly like the real
 * `clip-embedding` — promoted to root the same way.
 */
const embeddingRootDefinition: StepDefinition = {
  id: 'test-clip-embedding',
  name: 'Test CLIP Embedding',
  slot: 'classifier',
  postprocessor: 'clip',
  extractMode: 'crop-roi',
  inputClasses: ['person', 'vehicle', 'animal'],
  outputClasses: ['embedding'],
  models: [makeModelEntry('stub-embedding-model')],
  defaultModelId: 'stub-embedding-model',
  defaultConfidence: 0,
}

/**
 * An OCR step definition scoped like the real `plate-ocr` — normally a CHILD of
 * `plate-detection`, promoted to root when the caller already holds the cut
 * plate crop.
 */
const textRootDefinition: StepDefinition = {
  id: 'test-plate-ocr',
  name: 'Test Plate OCR',
  slot: 'classifier',
  postprocessor: 'ctc',
  extractMode: 'crop-roi',
  inputClasses: ['plate'],
  outputClasses: ['plate'],
  models: [makeModelEntry('stub-ocr-model')],
  defaultModelId: 'stub-ocr-model',
  defaultConfidence: 0,
}

function makeStubEngine(output: EngineOutput): IInferenceEngine & {
  readonly infer: ReturnType<typeof vi.fn>
} {
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(async (_input: InferenceInput): Promise<EngineOutput> => output),
    dispose: async () => {},
  }
}

async function makeFrameJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      channels: 3,
      background: { r: 5, g: 5, b: 5 },
    },
  })
    .jpeg()
    .toBuffer()
}

function buildSingleRootTree(definition: StepDefinition, engine: IInferenceEngine): ExecutableTree {
  const rootStep: ExecutableStep = {
    stepId: definition.id,
    definition,
    engine,
    modelId: definition.defaultModelId,
    inputClasses: definition.inputClasses ?? [],
    enabled: true,
    children: [],
  }

  return { roots: [rootStep] }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineExecutor — root-level classifier/embedding synthesis (task 6b)', () => {
  it('synthesizes a full-frame detection carrying the label + score for a classification-kind root', async () => {
    const engine = makeStubEngine({
      inferenceMs: 1,
      structured: {
        kind: 'classifications',
        classifications: [{ class: 'labrador', score: 0.92 }],
      },
    })
    const tree = buildSingleRootTree(classifierRootDefinition, engine)

    const fullFrameJpegProvider = vi.fn(makeFrameJpeg)
    const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })

    const { result } = await executor.run(
      tree,
      { kind: 'jpeg', data: await makeFrameJpeg() },
      fullFrameJpegProvider,
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      { plane: 'full' },
    )

    expect(engine.infer).toHaveBeenCalledTimes(1)
    expect(result.detections).toHaveLength(1)

    const detection = result.detections[0]
    expect(detection?.kind).toBe('first-level')
    // outputClasses[0] of the classifier step definition.
    expect(detection?.macroClass).toBe('animal-type')
    // The classification's own confidence, per requirement.
    expect(detection?.score).toBe(0.92)
    // Full-frame bbox — no detector to bound a smaller box.
    expect(detection?.bbox).toEqual({ x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT })
    // Same attachment applyChildOutput performs for a classification child:
    // the top-1 winner becomes an own label.
    expect(detection?.labels).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'labrador', score: 0.92 })]),
    )
  })

  it('synthesizes a full-frame detection carrying the embedding for an embedding-kind root', async () => {
    const embeddingNorm = [0.6, 0.8]
    const engine = makeStubEngine({
      inferenceMs: 1,
      structured: {
        kind: 'embedding',
        embedding: [3, 4],
        embeddingNorm,
      },
    })
    const tree = buildSingleRootTree(embeddingRootDefinition, engine)

    const fullFrameJpegProvider = vi.fn(makeFrameJpeg)
    const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })

    const { result } = await executor.run(
      tree,
      { kind: 'jpeg', data: await makeFrameJpeg() },
      fullFrameJpegProvider,
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      { plane: 'full' },
    )

    expect(engine.infer).toHaveBeenCalledTimes(1)
    expect(result.detections).toHaveLength(1)

    const detection = result.detections[0]
    expect(detection?.kind).toBe('first-level')
    // outputClasses[0] of the embedding step definition.
    expect(detection?.macroClass).toBe('embedding')
    // No confidence on an embedding output — defaults to 1.
    expect(detection?.score).toBe(1)
    expect(detection?.bbox).toEqual({ x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT })
    // Same attachment applyChildOutput performs for an embedding child.
    expect(detection?.embedding).toEqual(embeddingNorm)
    expect(detection?.embeddingModelId).toBe('stub-embedding-model')
  })

  it('synthesizes a full-frame detection carrying the OCR text for a text-kind root', async () => {
    // `plate-ocr` run STANDALONE on an already-cut plate crop: `isEnrichmentOutput`
    // admits `'text'` so the read is not silently dropped. The synthesized
    // detection carries the OCR read as an own label AND scores the box with the
    // read's own confidence — the same rule the classification root follows.
    const engine = makeStubEngine({
      inferenceMs: 1,
      structured: { kind: 'text', text: 'AB123CD', confidence: 0.77 },
    })
    const tree = buildSingleRootTree(textRootDefinition, engine)

    const fullFrameJpegProvider = vi.fn(makeFrameJpeg)
    const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })

    const { result } = await executor.run(
      tree,
      { kind: 'jpeg', data: await makeFrameJpeg() },
      fullFrameJpegProvider,
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      { plane: 'full' },
    )

    expect(engine.infer).toHaveBeenCalledTimes(1)
    expect(result.detections).toHaveLength(1)

    const detection = result.detections[0]
    expect(detection?.kind).toBe('first-level')
    // outputClasses[0] of the OCR step definition.
    expect(detection?.macroClass).toBe('plate')
    // The read's own confidence, per requirement.
    expect(detection?.score).toBe(0.77)
    expect(detection?.bbox).toEqual({ x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT })
    // Same attachment applyChildOutput performs for a text child.
    expect(detection?.labels).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'AB123CD', score: 0.77 })]),
    )
  })

  it('a detector-kind root is unaffected (no synthesis, normal detection path)', async () => {
    const detectorDefinition: StepDefinition = {
      id: 'test-object-detection',
      name: 'Test Object Detection',
      slot: 'detector',
      postprocessor: 'yolo',
      extractMode: 'full-frame',
      inputClasses: null,
      outputClasses: ['person'],
      models: [makeModelEntry('stub-root-model')],
      defaultModelId: 'stub-root-model',
      defaultConfidence: 0.5,
    }
    const engine = makeStubEngine({
      inferenceMs: 1,
      structured: {
        kind: 'detections',
        detections: [{ class: 'person', score: 0.9, bbox: [1, 1, 5, 5] }],
      },
    })
    const tree = buildSingleRootTree(detectorDefinition, engine)

    const fullFrameJpegProvider = vi.fn(makeFrameJpeg)
    const pipelineExecutor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })
    const { result: runResult } = await pipelineExecutor.run(
      tree,
      { kind: 'jpeg', data: await makeFrameJpeg() },
      fullFrameJpegProvider,
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      { plane: 'full' },
    )

    expect(runResult.detections).toHaveLength(1)
    expect(runResult.detections[0]?.macroClass).toBe('person')
    expect(runResult.detections[0]?.bbox).toEqual({ x: 1, y: 1, width: 4, height: 4 })
  })
})

// ---------------------------------------------------------------------------
// Critical C1 Part 1 — a face-detection subtree ROOT must carry the engine's
// landmarks onto its first-level detections, exactly as the cropper-SPAWNED
// detail path does, so the nested face-embedding child can align the ArcFace
// crop (and set `faceAlignedCrop`) instead of falling back to a plain crop.
// ---------------------------------------------------------------------------

// A face bbox (short side 50px ≥ DEFAULT_MIN_FACE_SIZE_PX=28) with 5 landmarks
// inside it — enough for the executor's face-alignment path to run the warp.
const FACE_BBOX: readonly [number, number, number, number] = [30, 20, 80, 70]
const FACE_LANDMARKS: readonly { readonly x: number; readonly y: number }[] = [
  { x: 45, y: 38 },
  { x: 65, y: 38 },
  { x: 55, y: 50 },
  { x: 47, y: 60 },
  { x: 63, y: 60 },
]

/** A face-detection-shaped ROOT: detector output, outputClasses ['face']. */
const faceDetectionRootDefinition: StepDefinition = {
  id: 'test-face-detection',
  name: 'Test Face Detection',
  slot: 'cropper',
  postprocessor: 'scrfd',
  extractMode: 'full-frame',
  inputClasses: ['person'],
  outputClasses: ['face'],
  models: [makeModelEntry('stub-face-det-model')],
  defaultModelId: 'stub-face-det-model',
  defaultConfidence: 0.2,
}

/** A face-embedding CHILD: arcface, faceAlignment model, embedding output. */
const faceEmbeddingChildDefinition: StepDefinition = {
  id: 'test-face-embedding',
  name: 'Test Face Embedding',
  slot: 'classifier',
  postprocessor: 'arcface',
  extractMode: 'crop-roi',
  inputClasses: ['face'],
  outputClasses: ['identity'],
  models: [
    {
      ...makeModelEntry('stub-arcface-model'),
      inputSize: { width: 112, height: 112 },
      faceAlignment: true,
    },
  ],
  defaultModelId: 'stub-arcface-model',
  defaultConfidence: 0,
}

describe('PipelineExecutor — root face landmarks (Critical C1 Part 1)', () => {
  it('toMutableRootDetection carries engine landmarks onto the assembled root detection', () => {
    const engine = makeStubEngine({
      inferenceMs: 1,
      structured: { kind: 'detections', detections: [] },
    })
    const rootStep: ExecutableStep = {
      stepId: faceDetectionRootDefinition.id,
      definition: faceDetectionRootDefinition,
      engine,
      modelId: faceDetectionRootDefinition.defaultModelId,
      inputClasses: faceDetectionRootDefinition.inputClasses ?? [],
      enabled: true,
      children: [],
    }

    const root = toMutableRootDetection(
      { class: 'face', score: 0.9, bbox: FACE_BBOX, landmarks: FACE_LANDMARKS },
      rootStep,
      new FrameIdGenerator(),
      1,
    )

    expect(root.landmarks).toEqual(FACE_LANDMARKS)
  })

  it('a detections-kind ROOT with landmarks lets the face-embedding child align (sets faceAlignedCrop)', async () => {
    // The public `FrameResult.detections` (ObjectDetection) does NOT expose the
    // internal `landmarks` field, so the observable proof that the root carried
    // them is that the nested face-embedding child took the ALIGNED path and set
    // `faceAlignedCrop` (only reachable when `parentDetection.landmarks` is
    // present). We therefore assert the child effect rather than the raw field.
    const rootEngine = makeStubEngine({
      inferenceMs: 1,
      structured: {
        kind: 'detections',
        detections: [{ class: 'face', score: 0.9, bbox: FACE_BBOX, landmarks: FACE_LANDMARKS }],
      },
    })
    const childEngine = makeStubEngine({
      inferenceMs: 1,
      structured: { kind: 'embedding', embedding: [3, 4], embeddingNorm: [0.6, 0.8] },
    })

    const childStep: ExecutableStep = {
      stepId: faceEmbeddingChildDefinition.id,
      definition: faceEmbeddingChildDefinition,
      engine: childEngine,
      modelId: faceEmbeddingChildDefinition.defaultModelId,
      inputClasses: faceEmbeddingChildDefinition.inputClasses ?? [],
      enabled: true,
      children: [],
    }
    const rootStep: ExecutableStep = {
      stepId: faceDetectionRootDefinition.id,
      definition: faceDetectionRootDefinition,
      engine: rootEngine,
      modelId: faceDetectionRootDefinition.defaultModelId,
      inputClasses: faceDetectionRootDefinition.inputClasses ?? [],
      enabled: true,
      children: [childStep],
    }
    const tree: ExecutableTree = { roots: [rootStep] }

    const fullFrameJpegProvider = vi.fn(makeFrameJpeg)
    const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })

    const { result } = await executor.run(
      tree,
      { kind: 'jpeg', data: await makeFrameJpeg() },
      fullFrameJpegProvider,
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      { plane: 'full' },
    )

    expect(result.detections).toHaveLength(1)
    const face = result.detections[0]
    expect(face?.macroClass).toBe('face')
    // Aligned path ran → embedding + the exact ArcFace input crop are present.
    expect(face?.embedding).toEqual([0.6, 0.8])
    expect(face?.faceAlignedCrop).toBeDefined()
    expect(typeof face?.faceAlignedCrop).toBe('string')
  })
})
