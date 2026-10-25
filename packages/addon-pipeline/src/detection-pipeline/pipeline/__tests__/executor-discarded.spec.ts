/**
 * Discarded-detection trail — the server half of the viewer's ghost-box
 * overlay. The executor's drop sites must record every POST-NMS box they
 * remove, with the honest reason code, onto `FrameResult.discarded` —
 * UNCONDITIONALLY. The former `emitDiscarded` step setting is deliberately
 * gone (operator decision, 2026-08-01): the discarded set is post-NMS and
 * post-confidence-floor — a handful of boxes per frame — so the boxes
 * always ride the event.
 *
 *   - `class-filter`: macro not in `enabledMacroClasses`, or an unmapped
 *     COCO class (both count toward the trace's model-saw/kept gap).
 *   - `below-threshold`: score under `minConfidence<Macro>`.
 *   - `full-frame-guard`: the cam-101 phantom guard.
 *
 * (`nms` no longer exists as a reason: every engine's NMS runs inside the
 * Python pool and its suppressed set never crosses the boundary.)
 *
 * The one remaining absence rule: a frame that drops NOTHING carries no
 * `discarded` field at all — absent, never an empty array on the wire.
 *
 * Coordinate space: `discarded[].bbox` is the executor's `[x1,y1,x2,y2]`
 * tuple in absolute analysis-frame pixels — exactly what the viewer's
 * `parseDiscardedEvent` normalises against `frame.width`/`height`.
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

/** Root detector wired with the real COCO->macro map (like production). */
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

function buildTree(
  engine: IInferenceEngine,
  settings: Readonly<Record<string, unknown>>,
): ExecutableTree {
  const rootStep: ExecutableStep = {
    stepId: rootStepDefinition.id,
    definition: rootStepDefinition,
    engine,
    modelId: rootStepDefinition.defaultModelId,
    inputClasses: [],
    enabled: true,
    children: [],
    settings,
    effectiveClassMap: rootStepDefinition.classMap,
  }
  return { roots: [rootStep] }
}

interface StructuredDetections {
  readonly kind: 'detections'
  readonly detections: readonly {
    readonly class: string
    readonly score: number
    readonly bbox: readonly [number, number, number, number]
  }[]
}

async function runWith(
  structured: StructuredDetections,
  settings: Readonly<Record<string, unknown>>,
): Promise<FrameResult> {
  const engine = makeStubEngine({
    inferenceMs: 1,
    structured: { ...structured },
  })
  const executor = new PipelineExecutor({ engineRuntime: 'python+cpu' })
  const { result } = await executor.run(
    buildTree(engine, settings),
    { kind: 'jpeg', data: await makeFrameJpeg() },
    vi.fn(makeFrameJpeg),
    FRAME_WIDTH,
    FRAME_HEIGHT,
    1,
    { plane: 'frame' },
  )
  return result
}

const det = (
  cls: string,
  score: number,
  bbox: readonly [number, number, number, number] = [10, 10, 50, 50],
): {
  class: string
  score: number
  bbox: readonly [number, number, number, number]
} => ({
  class: cls,
  score,
  bbox,
})

describe('PipelineExecutor — discarded-detection trail (always on)', () => {
  it('records drops WITHOUT any flag in settings — there is no off switch', async () => {
    // The settings deliberately mention no diagnostic key at all: the trail
    // must ride regardless. This is the inverse of the retired "flag OFF ⇒
    // no field" contract.
    const result = await runWith(
      { kind: 'detections', detections: [det('cat', 0.9)] },
      { enabledMacroClasses: ['person'] },
    )
    expect(result.detections).toHaveLength(0)
    expect(result.discarded).toHaveLength(1)
    expect(result.discarded?.[0]?.reason).toBe('class-filter')
  })

  it('records a class-filter drop (macro not enabled) with the pixel-tuple bbox', async () => {
    const result = await runWith(
      { kind: 'detections', detections: [det('cat', 0.9, [12, 34, 56, 78])] },
      { enabledMacroClasses: ['person'] },
    )
    expect(result.detections).toHaveLength(0)
    expect(result.discarded).toEqual([
      {
        bbox: [12, 34, 56, 78],
        macroClass: 'animal',
        score: 0.9,
        reason: 'class-filter',
      },
    ])
  })

  it('records an UNMAPPED COCO class as class-filter (it counts in the trace gap)', async () => {
    const result = await runWith(
      { kind: 'detections', detections: [det('traffic light', 0.7)] },
      {},
    )
    expect(result.detections).toHaveLength(0)
    expect(result.discarded).toHaveLength(1)
    expect(result.discarded?.[0]?.reason).toBe('class-filter')
  })

  it('records a below-threshold drop (per-macro minConfidence slider)', async () => {
    const result = await runWith(
      { kind: 'detections', detections: [det('person', 0.5)] },
      {
        enabledMacroClasses: ['person'],
        minConfidencePerson: 0.8,
      },
    )
    expect(result.detections).toHaveLength(0)
    expect(result.discarded).toEqual([
      {
        bbox: [10, 10, 50, 50],
        macroClass: 'person',
        score: 0.5,
        reason: 'below-threshold',
      },
    ])
  })

  it('records a full-frame-guard drop (the cam-101 phantom)', async () => {
    const result = await runWith(
      {
        kind: 'detections',
        // Full-frame box below the guard's 0.70 confidence bar → phantom.
        detections: [det('person', 0.52, [0, 0, FRAME_WIDTH, FRAME_HEIGHT])],
      },
      {
        enabledMacroClasses: ['person'],
        minConfidencePerson: 0.3,
      },
    )
    expect(result.detections).toHaveLength(0)
    expect(result.discarded).toEqual([
      {
        bbox: [0, 0, FRAME_WIDTH, FRAME_HEIGHT],
        macroClass: 'person',
        score: 0.52,
        reason: 'full-frame-guard',
      },
    ])
  })

  it('keeps survivors and discards side by side on a mixed frame', async () => {
    const result = await runWith(
      {
        kind: 'detections',
        detections: [det('person', 0.9), det('person', 0.4, [60, 60, 90, 90])],
      },
      {
        enabledMacroClasses: ['person'],
        minConfidencePerson: 0.6,
      },
    )
    expect(result.detections).toHaveLength(1)
    expect(result.detections[0]?.score).toBe(0.9)
    expect(result.discarded).toHaveLength(1)
    expect(result.discarded?.[0]?.reason).toBe('below-threshold')
  })

  it('an ALL-discarded frame still carries its discard trail (the case the overlay exists for)', async () => {
    const result = await runWith(
      {
        kind: 'detections',
        detections: [det('person', 0.4), det('cat', 0.9, [60, 60, 90, 90])],
      },
      {
        enabledMacroClasses: ['person'],
        minConfidencePerson: 0.6,
      },
    )
    expect(result.detections).toHaveLength(0)
    expect(result.discarded).toHaveLength(2)
    const reasons = result.discarded?.map((d) => d.reason).toSorted()
    expect(reasons).toEqual(['below-threshold', 'class-filter'])
  })

  it('nothing dropped → no discarded field (absent, not empty)', async () => {
    const result = await runWith(
      { kind: 'detections', detections: [det('person', 0.9)] },
      { enabledMacroClasses: ['person'] },
    )
    expect(result.detections).toHaveLength(1)
    expect(result.discarded).toBeUndefined()
  })
})
