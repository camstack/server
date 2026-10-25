/**
 * Regression guard for the "benchmark stays on loading forever" hang.
 *
 * Root cause: a full-tree (`plane:'full'`) benchmark run walks the enabled
 * crop/enrichment children. Each child inference goes through the shared
 * Python pool, whose per-request `dispatch` had NO timeout — a worker that
 * stayed alive but never replied to a specific request wedged the awaiting
 * promise forever, and since the client awaits the mutation with no timeout,
 * the UI hung on "loading" indefinitely.
 *
 * The fix bounds the pool request (POOL_INFER_TIMEOUT_MS): a wedged request
 * now REJECTS instead of hanging. This test proves the executor degrades that
 * rejection gracefully — the full-tree run always COMPLETES and still returns
 * the ROOT detections (+ debug), exactly the "run the chain, report the boxes"
 * behaviour, rather than blocking. A rejecting child stands in for the
 * timed-out pool request.
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

/** Engine whose inference REJECTS — stands in for a timed-out pool request. */
function makeRejectingEngine(): IInferenceEngine & { readonly infer: ReturnType<typeof vi.fn> } {
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(async (_input: InferenceInput): Promise<EngineOutput> => {
      throw new Error(
        'PoolWorker[stub]: inference request 7 timed out after 60000ms (worker alive, no reply)',
      )
    }),
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

describe('PipelineExecutor — full-tree child hang guard', () => {
  it('a rejecting (timed-out) crop child does NOT wedge the run — root detections + debug still returned', async () => {
    const rootEngine = makeStubEngine({
      inferenceMs: 1,
      structured: {
        kind: 'detections',
        detections: [{ class: 'person', score: 0.9, bbox: [10, 10, 50, 50] }],
      },
    })
    const childEngine = makeRejectingEngine()
    const tree = buildTree(rootEngine, childEngine)

    const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })

    // The whole point: this resolves (does not hang, does not throw) even
    // though the child inference rejected — the run completes with the root.
    const { result } = await executor.run(
      tree,
      { kind: 'jpeg', data: await makeFrameJpeg() },
      vi.fn(makeFrameJpeg),
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      { plane: 'full' },
    )

    expect(rootEngine.infer).toHaveBeenCalledTimes(1)
    // The child was attempted (full plane) and rejected — but was swallowed.
    expect(childEngine.infer).toHaveBeenCalledTimes(1)
    // Root detection survives — "report the boxes" behaviour is preserved.
    expect(result.detections).toHaveLength(1)
    expect(result.detections[0]?.macroClass).toBe('person')
    // Full-tree debug bag is populated (verbosity 'full' for benchmark path).
    expect(result.debug).toBeDefined()
  })
})
