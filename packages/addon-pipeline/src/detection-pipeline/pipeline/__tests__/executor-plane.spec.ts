/**
 * Two-plane execution — `plane: 'frame'` (live per-frame dispatch) must
 * skip crop children entirely (never touching the engine or paying the
 * lazy full-frame JPEG encode) while still running root-plane steps and
 * keeping their detections in the result. `plane: 'full'` (and the
 * default/undefined) preserve today's whole-tree behaviour.
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
import type { ExecutableStep, ExecutableTree } from '../tree-builder.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRAME_WIDTH = 200
const FRAME_HEIGHT = 200

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

/** Root detector step definition — `inputClasses: null` marks it root-plane. */
const rootStepDefinition: StepDefinition = {
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

/** Crop child step definition — non-null `inputClasses` marks it a crop child. */
const cropChildStepDefinition: StepDefinition = {
  id: 'test-face-detection',
  name: 'Test Face Detection',
  slot: 'cropper',
  postprocessor: 'scrfd',
  extractMode: 'crop-roi',
  inputClasses: ['person'],
  outputClasses: ['face'],
  models: [makeModelEntry('stub-child-model')],
  defaultModelId: 'stub-child-model',
  defaultConfidence: 0.5,
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
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .jpeg()
    .toBuffer()
}

function buildTree(rootEngine: IInferenceEngine, childEngine: IInferenceEngine): ExecutableTree {
  const childStep: ExecutableStep = {
    stepId: cropChildStepDefinition.id,
    definition: cropChildStepDefinition,
    engine: childEngine,
    modelId: cropChildStepDefinition.defaultModelId,
    inputClasses: cropChildStepDefinition.inputClasses ?? [],
    enabled: true,
    children: [],
  }

  const rootStep: ExecutableStep = {
    stepId: rootStepDefinition.id,
    definition: rootStepDefinition,
    engine: rootEngine,
    modelId: rootStepDefinition.defaultModelId,
    inputClasses: rootStepDefinition.inputClasses ?? [],
    enabled: true,
    children: [childStep],
  }

  return { roots: [rootStep] }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineExecutor — two-plane dispatch', () => {
  it("plane: 'frame' skips the crop-child engine entirely but keeps the root detection", async () => {
    const rootEngine = makeStubEngine({
      inferenceMs: 1,
      structured: {
        kind: 'detections',
        detections: [{ class: 'person', score: 0.9, bbox: [10, 10, 50, 50] }],
      },
    })
    const childEngine = makeStubEngine({
      inferenceMs: 1,
      structured: { kind: 'detections', detections: [] },
    })
    const tree = buildTree(rootEngine, childEngine)

    const fullFrameJpegProvider = vi.fn(makeFrameJpeg)
    const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })

    const { result } = await executor.run(
      tree,
      { kind: 'jpeg', data: await makeFrameJpeg() },
      fullFrameJpegProvider,
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      { plane: 'frame' },
    )

    expect(rootEngine.infer).toHaveBeenCalledTimes(1)
    expect(childEngine.infer).not.toHaveBeenCalled()
    // No crop child ran, so the lazy full-frame JPEG encode was never paid.
    expect(fullFrameJpegProvider).not.toHaveBeenCalled()

    expect(result.detections).toHaveLength(1)
    expect(result.detections[0]?.macroClass).toBe('person')
  })

  it.each([
    ['full' as const, { plane: 'full' as const }],
    ['default (undefined)', {}],
  ])('plane: %s runs the crop child as before', async (_label, runOpts) => {
    const rootEngine = makeStubEngine({
      inferenceMs: 1,
      structured: {
        kind: 'detections',
        detections: [{ class: 'person', score: 0.9, bbox: [10, 10, 50, 50] }],
      },
    })
    const childEngine = makeStubEngine({
      inferenceMs: 1,
      structured: { kind: 'detections', detections: [] },
    })
    const tree = buildTree(rootEngine, childEngine)

    const fullFrameJpegProvider = vi.fn(makeFrameJpeg)
    const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })

    const { result } = await executor.run(
      tree,
      { kind: 'jpeg', data: await makeFrameJpeg() },
      fullFrameJpegProvider,
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      runOpts,
    )

    expect(rootEngine.infer).toHaveBeenCalledTimes(1)
    expect(childEngine.infer).toHaveBeenCalledTimes(1)
    expect(fullFrameJpegProvider).toHaveBeenCalled()
    expect(result.detections).toHaveLength(1)
  })
})
