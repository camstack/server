/**
 * Task 7A — executor reads `effectiveClassMap`, never mutates the shared
 * StepDefinition. A plugin catalog identity map must keep `vehicle`/`animal`;
 * a model without override keeps COCO (car→vehicle, unmapped dropped).
 */
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { buildPlusCatalogClassMap, COCO_TO_MACRO, plusCatalogLabelFields } from '@camstack/types'
import type {
  ClassMapDefinition,
  DetectionCatalogClassMap,
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

const IDENTITY: DetectionCatalogClassMap = {
  mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
  preserveOriginal: false,
}

function makeModelEntry(id: string, classMap?: DetectionCatalogClassMap): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: '',
    formats: {},
    inputSize: { width: 64, height: 64 },
    labels: [],
    ...(classMap !== undefined ? { classMap } : {}),
  }
}

const sharedDefinition: StepDefinition = {
  id: 'test-object-detection',
  name: 'Test Object Detection',
  slot: 'detector',
  postprocessor: 'yolo',
  extractMode: 'full-frame',
  inputClasses: null,
  outputClasses: ['person', 'vehicle', 'animal', 'package'],
  models: [makeModelEntry('plugin-catalog-yolo', IDENTITY), makeModelEntry('frigate-coco')],
  defaultModelId: 'frigate-coco',
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

function root(
  modelId: string,
  engine: IInferenceEngine,
  effectiveClassMap: ClassMapDefinition | undefined,
  enabledMacroClasses: readonly string[] = ['person', 'vehicle', 'animal'],
): ExecutableStep {
  return {
    stepId: sharedDefinition.id,
    definition: sharedDefinition,
    engine,
    modelId,
    inputClasses: [],
    enabled: true,
    children: [],
    settings: { enabledMacroClasses },
    effectiveClassMap,
  }
}

async function runTree(tree: ExecutableTree) {
  const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })
  const { result } = await executor.run(
    tree,
    { kind: 'jpeg', data: await makeFrameJpeg() },
    vi.fn(makeFrameJpeg),
    FRAME_WIDTH,
    FRAME_HEIGHT,
    1,
    // `full` so the raw class is carried in `debug.originalClass`.
    { plane: 'frame', traceVerbosity: 'full' },
  )
  return result.detections.map((d) => ({
    macroClass: d.macroClass,
    originalClass: d.debug?.originalClass,
  }))
}

function detectionsOutput(classes: readonly string[]): EngineOutput {
  return {
    inferenceMs: 1,
    structured: {
      kind: 'detections',
      detections: classes.map((cls, i) => ({
        class: cls,
        score: 0.9,
        bbox: [10 + i * 4, 10, 40, 40] as const,
      })),
    },
  }
}

describe('PipelineExecutor — per-model effectiveClassMap', () => {
  it('keeps vehicle and animal when the identity map wins over step COCO', async () => {
    const dets = await runTree({
      roots: [
        root(
          'plugin-catalog-yolo',
          makeStubEngine(detectionsOutput(['person', 'vehicle', 'animal'])),
          IDENTITY,
        ),
      ],
    })
    expect(dets.map((d) => d.macroClass).toSorted()).toEqual(['animal', 'person', 'vehicle'])
    expect(sharedDefinition.classMap).toBe(COCO_TO_MACRO)
  })

  it('drops an unmapped COCO class and maps car→vehicle when the model has no override', async () => {
    const dets = await runTree({
      roots: [
        root('frigate-coco', makeStubEngine(detectionsOutput(['car', 'carrot'])), COCO_TO_MACRO),
      ],
    })
    expect(dets.map((d) => d.macroClass)).toEqual(['vehicle'])
    expect(sharedDefinition.classMap).toBe(COCO_TO_MACRO)
  })

  it('applies a different map per root that shares one StepDefinition', async () => {
    const dets = await runTree({
      roots: [
        root('plugin-catalog-yolo', makeStubEngine(detectionsOutput(['vehicle'])), IDENTITY),
        root('frigate-coco', makeStubEngine(detectionsOutput(['car'])), COCO_TO_MACRO),
      ],
    })
    expect(dets.map((d) => d.macroClass).toSorted()).toEqual(['vehicle', 'vehicle'])
    expect(sharedDefinition.classMap).toBe(COCO_TO_MACRO)
    expect(sharedDefinition.classMap?.mapping.car).toBe('vehicle')
    expect(sharedDefinition.classMap?.mapping.vehicle).toBeUndefined()
  })

  // A plus catalog import used to carry no classMap, inherit COCO_TO_MACRO and lose
  // every label COCO does not name.
  const PLUS_CATALOG_PLUS = buildPlusCatalogClassMap([
    'person',
    'deer',
    'school_bus',
    'package',
    'face',
  ])

  it('a plus catalog `deer` survives as animal with originalClass deer', async () => {
    const dets = await runTree({
      roots: [root('frigate-plus', makeStubEngine(detectionsOutput(['deer'])), PLUS_CATALOG_PLUS)],
    })
    expect(dets).toEqual([{ macroClass: 'animal', originalClass: 'deer' }])
  })

  it('a plus catalog `package` maps to package, school_bus to vehicle, face is dropped', async () => {
    const dets = await runTree({
      roots: [
        root(
          'frigate-plus',
          makeStubEngine(detectionsOutput(['package', 'school_bus', 'face'])),
          PLUS_CATALOG_PLUS,
          ['person', 'vehicle', 'animal', 'package'],
        ),
      ],
    })
    expect(dets.toSorted((a, b) => a.macroClass.localeCompare(b.macroClass))).toEqual([
      { macroClass: 'package', originalClass: 'package' },
      { macroClass: 'vehicle', originalClass: 'school_bus' },
    ])
  })

  // D715/D730: a model that declares a label supply writes the classifier's
  // effect onto the detection as a linked label — score 0 here, the runner owns
  // the authority.
  describe('linked label', () => {
    const PLUS_LABELS = ['person', 'deer', 'car', 'package', 'bear'] as const
    const fields = plusCatalogLabelFields(PLUS_LABELS)

    async function runLinked(classes: readonly string[]) {
      const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })
      const step: ExecutableStep = {
        ...root('frigate-plus', makeStubEngine(detectionsOutput(classes)), fields.classMap, [
          'person',
          'vehicle',
          'animal',
          'package',
        ]),
        ...(fields.suppliesSteps !== undefined ? { rootSupplies: fields.suppliesSteps } : {}),
      }
      const { result } = await executor.run(
        { roots: [step] },
        { kind: 'jpeg', data: await makeFrameJpeg() },
        vi.fn(makeFrameJpeg),
        FRAME_WIDTH,
        FRAME_HEIGHT,
        1,
        { plane: 'frame' },
      )
      return result.detections
    }

    it('a plus catalog deer carries the animal-classifier effect as a linked tier-1 label', async () => {
      const [deer] = await runLinked(['deer'])
      expect(deer?.labels).toEqual([
        {
          label: 'deer',
          score: 0,
          tier: 1,
          stepId: 'detector-link:animal-classifier',
          modelId: 'frigate-plus',
        },
      ])
    })

    it('car links in the vehicle classifier spelling; package and bear link nothing', async () => {
      const dets = await runLinked(['car', 'package', 'bear'])
      const byMacro = new Map(dets.map((d) => [d.macroClass, d.labels ?? []]))
      expect(byMacro.get('vehicle')?.map((l) => [l.label, l.stepId])).toEqual([
        ['Car', 'detector-link:vehicle-classifier'],
      ])
      expect(byMacro.get('package')).toEqual([])
      expect(byMacro.get('animal')).toEqual([])
    })
  })
})
