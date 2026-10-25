/**
 * Phase-2 (package-zones) — the `package` macro must flow through the
 * executor end-to-end: a COCO `suitcase`/`backpack`/`handbag` root
 * detection maps to `macroClass: 'package'` (interim vector via
 * COCO_TO_MACRO) and survives `macroFilterVerdict` iff the camera opted
 * `package` into `enabledMacroClasses` and the score clears an optional
 * `minConfidencePackage`. This is the model-agnostic contract: swap the
 * class source (dedicated parcel model emitting `class: 'package'`) and
 * the same gate applies.
 *
 * See docs/superpowers/specs/2026-07-17-package-zones-design.md §3.2 / §4.
 */
import { describe, it, expect, vi } from 'vitest'
import sharp from 'sharp'
import { COCO_TO_MACRO } from '@camstack/types'
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

/** Root detector wired with the real COCO->macro map so `suitcase` maps. */
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

async function runWith(
  rawClass: string,
  score: number,
  settings: Readonly<Record<string, unknown>>,
): Promise<readonly { macroClass: string }[]> {
  const engine = makeStubEngine({
    inferenceMs: 1,
    structured: {
      kind: 'detections',
      detections: [{ class: rawClass, score, bbox: [10, 10, 50, 50] }],
    },
  })
  const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })
  const { result } = await executor.run(
    buildTree(engine, settings),
    { kind: 'jpeg', data: await makeFrameJpeg() },
    vi.fn(makeFrameJpeg),
    FRAME_WIDTH,
    FRAME_HEIGHT,
    1,
    { plane: 'frame' },
  )
  return result.detections.map((d) => ({ macroClass: d.macroClass }))
}

describe('PipelineExecutor — package macro flow', () => {
  it.each([
    'suitcase',
    'backpack',
    'handbag',
  ])('maps COCO %s to macroClass package when package is enabled', async (rawClass) => {
    const dets = await runWith(rawClass, 0.9, {
      enabledMacroClasses: ['person', 'vehicle', 'animal', 'package'],
    })
    expect(dets).toHaveLength(1)
    expect(dets[0]?.macroClass).toBe('package')
  })

  it('drops a package detection when the camera did NOT opt package in', async () => {
    const dets = await runWith('suitcase', 0.9, {
      enabledMacroClasses: ['person', 'vehicle', 'animal'],
    })
    expect(dets).toHaveLength(0)
  })

  it('applies the per-macro minConfidencePackage gate', async () => {
    const dets = await runWith('suitcase', 0.6, {
      enabledMacroClasses: ['package'],
      minConfidencePackage: 0.8,
    })
    expect(dets).toHaveLength(0)
  })

  it('keeps a package detection above minConfidencePackage', async () => {
    const dets = await runWith('backpack', 0.85, {
      enabledMacroClasses: ['package'],
      minConfidencePackage: 0.8,
    })
    expect(dets).toHaveLength(1)
    expect(dets[0]?.macroClass).toBe('package')
  })
})
