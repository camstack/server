/**
 * First-class shed marker on `FrameResult`.
 *
 * When the pool sheds a ROOT step under overload (`EngineOutput.dropped`),
 * the executor skips the step and — before this marker existed — the frame
 * came out indistinguishable from "genuinely no detections". Every consumer
 * that needs to count sheds (the capacity ramp's drop accounting, the
 * runner's timing sampler) had to GUESS from an empty detections array,
 * which misreads an actually-empty scene as a shed and vice versa.
 *
 * The contract pinned here:
 *   - a shed root ⇒ `result.shed === true` + `result.shedReason` carries the
 *     pool's bound name (e.g. `'worker-in-flight-cap'`);
 *   - a frame whose root actually ran ⇒ NO `shed` field at all (absent,
 *     never `false`) — same absence rule as `discarded`;
 *   - a shed with no reason string still marks the frame (reason defaults
 *     to `'pool-overload'`, mirroring the executor's trace label).
 */

import type {
  EngineOutput,
  FrameResult,
  IInferenceEngine,
  InferenceInput,
  ModelCatalogEntry,
  StepDefinition,
} from '@camstack/types'
import { COCO_TO_MACRO } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
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
  outputClasses: ['person', 'vehicle', 'animal', 'package'],
  models: [makeModelEntry('stub-root-model')],
  defaultModelId: 'stub-root-model',
  defaultConfidence: 0.5,
  labels: [],
  classMap: COCO_TO_MACRO,
}

function makeStubEngine(output: EngineOutput): IInferenceEngine {
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

function buildTree(engine: IInferenceEngine): ExecutableTree {
  const rootStep: ExecutableStep = {
    stepId: rootStepDefinition.id,
    definition: rootStepDefinition,
    engine,
    modelId: rootStepDefinition.defaultModelId,
    inputClasses: [],
    enabled: true,
    children: [],
    settings: { enabledMacroClasses: ['person'] },
    effectiveClassMap: rootStepDefinition.classMap,
  }
  return { roots: [rootStep] }
}

async function runWithEngineOutput(output: EngineOutput): Promise<FrameResult> {
  const engine = makeStubEngine(output)
  const executor = new PipelineExecutor({ engineRuntime: 'python+cpu' })
  const { result } = await executor.run(
    buildTree(engine),
    { kind: 'jpeg', data: await makeFrameJpeg() },
    vi.fn(makeFrameJpeg),
    FRAME_WIDTH,
    FRAME_HEIGHT,
    1,
    { plane: 'frame' },
  )
  return result
}

describe('PipelineExecutor — first-class shed marker on FrameResult', () => {
  it('a shed root marks the frame: shed=true + the shedding bound as the reason', async () => {
    const result = await runWithEngineOutput({
      inferenceMs: 0,
      dropped: true,
      shedReason: 'worker-in-flight-cap',
    })
    expect(result.shed).toBe(true)
    expect(result.shedReason).toBe('worker-in-flight-cap')
    expect(result.detections).toHaveLength(0)
  })

  it('a shed WITHOUT a reason string still marks the frame (default reason)', async () => {
    const result = await runWithEngineOutput({ inferenceMs: 0, dropped: true })
    expect(result.shed).toBe(true)
    expect(result.shedReason).toBe('pool-overload')
  })

  it('a root that actually ran carries NO shed field — absent, never false', async () => {
    const result = await runWithEngineOutput({
      inferenceMs: 1,
      structured: {
        kind: 'detections',
        detections: [{ class: 'person', score: 0.9, bbox: [10, 10, 50, 50] }],
      },
    })
    expect(result.detections).toHaveLength(1)
    expect(result.shed).toBeUndefined()
    expect(result.shedReason).toBeUndefined()
    expect('shed' in result).toBe(false)
  })

  it('a genuinely-EMPTY frame (root ran, zero boxes) is NOT marked shed', async () => {
    const result = await runWithEngineOutput({
      inferenceMs: 1,
      structured: { kind: 'detections', detections: [] },
    })
    expect(result.detections).toHaveLength(0)
    expect(result.shed).toBeUndefined()
  })
})
