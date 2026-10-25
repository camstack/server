/**
 * D730 in the executor:
 *  - a root `license_plate` / `face` the root declares as a CROP supply becomes
 *    a DETAIL of the vehicle / person that contains it — never a first-level
 *    detection, so never a track (D683); an uncontained one makes nothing;
 *  - on the detail plane, `suppliedRoot` replaces the crop step's inference and
 *    its plate reader cuts the root's box with the ROOT-box margin.
 */
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { plusCatalogLabelFields } from '@camstack/types'
import type {
  EngineOutput,
  IInferenceEngine,
  InferenceInput,
  IScopedLogger,
  ModelCatalogEntry,
  StepDefinition,
} from '@camstack/types'
import { PipelineExecutor } from '../executor.js'
import { ROOT_SUPPLIED_PLATE_MARGIN_FRACTION } from '../plate-ocr-crop-policy.js'
import type { ExecutableStep } from '../tree-builder.js'

const W = 200
const H = 200

function entry(id: string): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: '',
    formats: {},
    inputSize: { width: 64, height: 64 },
    labels: [],
  }
}

function engine(
  output: EngineOutput,
): IInferenceEngine & { readonly infer: ReturnType<typeof vi.fn> } {
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(async (_input: InferenceInput): Promise<EngineOutput> => output),
    dispose: async () => {},
  }
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: W, height: H, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .jpeg()
    .toBuffer()
}

const PLUS_LABELS = ['person', 'car', 'license_plate', 'face'] as const
const fields = plusCatalogLabelFields(PLUS_LABELS)

const rootDefinition: StepDefinition = {
  id: 'object-detection',
  name: 'Object Detection',
  slot: 'detector',
  postprocessor: 'yolo',
  extractMode: 'full-frame',
  inputClasses: null,
  outputClasses: ['person', 'vehicle', 'animal', 'package'],
  models: [entry('frigate-plus')],
  defaultModelId: 'frigate-plus',
  defaultConfidence: 0.1,
}

type Box = readonly [number, number, number, number]

async function runFrame(boxes: readonly { readonly cls: string; readonly bbox: Box }[]) {
  const step: ExecutableStep = {
    stepId: rootDefinition.id,
    definition: rootDefinition,
    engine: engine({
      inferenceMs: 1,
      structured: {
        kind: 'detections',
        detections: boxes.map((b) => ({ class: b.cls, score: 0.8, bbox: [...b.bbox] })),
      },
    }),
    modelId: 'frigate-plus',
    inputClasses: [],
    enabled: true,
    children: [],
    settings: { enabledMacroClasses: ['person', 'vehicle'] },
    effectiveClassMap: fields.classMap,
    ...(fields.suppliesSteps !== undefined ? { rootSupplies: fields.suppliesSteps } : {}),
  }
  const { result } = await new PipelineExecutor({ engineRuntime: 'onnx+cpu' }).run(
    { roots: [step] },
    { kind: 'jpeg', data: await jpeg() },
    jpeg,
    W,
    H,
    1,
    { plane: 'frame' },
  )
  return result
}

describe('root child boxes — contained, attached, never first-level', () => {
  it("a plate inside a car becomes the car's plate detail", async () => {
    const result = await runFrame([
      { cls: 'car', bbox: [20, 20, 180, 150] },
      { cls: 'license_plate', bbox: [80, 120, 120, 135] },
    ])
    const car = result.detections.find((d) => d.macroClass === 'vehicle')
    const plate = result.detections.find((d) => d.macroClass === 'plate')
    expect(car?.kind).toBe('first-level')
    expect(plate).toMatchObject({
      kind: 'detail',
      parentId: car?.id,
      rootSupplied: { stepId: 'plate-detection', modelId: 'frigate-plus' },
    })
    expect(result.detections.filter((d) => d.kind === 'first-level')).toHaveLength(1)
  })

  it("a face inside a person becomes the person's face detail, never a track", async () => {
    const result = await runFrame([
      { cls: 'person', bbox: [50, 10, 120, 190] },
      { cls: 'face', bbox: [70, 20, 95, 50] },
    ])
    const person = result.detections.find((d) => d.macroClass === 'person')
    const face = result.detections.find((d) => d.macroClass === 'face')
    expect(face).toMatchObject({
      kind: 'detail',
      parentId: person?.id,
      rootSupplied: { stepId: 'face-detection' },
    })
    expect(
      result.detections.filter((d) => d.kind === 'first-level').map((d) => d.macroClass),
    ).toEqual(['person'])
  })

  it('a box no parent of the right macro contains makes nothing (a face inside a car)', async () => {
    const result = await runFrame([
      { cls: 'car', bbox: [20, 20, 180, 150] },
      { cls: 'face', bbox: [70, 30, 95, 60] },
      { cls: 'license_plate', bbox: [150, 170, 190, 190] },
    ])
    expect(result.detections.map((d) => d.macroClass)).toEqual(['vehicle'])
    expect(result.discarded?.filter((d) => d.reason === 'class-filter')).toHaveLength(2)
  })
})

describe("suppliedRoot — the detail plane reads the root's plate box", () => {
  const plateDefinition: StepDefinition = {
    id: 'plate-detection',
    name: 'Plate Detection',
    slot: 'cropper',
    postprocessor: 'yolo',
    extractMode: 'crop-roi',
    inputClasses: ['vehicle'],
    outputClasses: ['plate'],
    models: [entry('yolox-tiny-plate')],
    defaultModelId: 'yolox-tiny-plate',
    defaultConfidence: 0.5,
  }
  const ocrDefinition: StepDefinition = {
    id: 'plate-ocr',
    name: 'Plate OCR',
    slot: 'classifier',
    postprocessor: 'plate-slots',
    extractMode: 'crop-roi',
    inputClasses: ['plate'],
    outputClasses: ['plate-text'],
    models: [entry('cct')],
    defaultModelId: 'cct',
    defaultConfidence: 0,
  }

  it('the plate step is not inferred and the reader gets the root-box margin', async () => {
    const plateEngine = engine({
      inferenceMs: 1,
      structured: { kind: 'detections', detections: [] },
    })
    const ocrEngine = engine({
      inferenceMs: 1,
      structured: { kind: 'text', text: 'X', confidence: 1 },
    })
    const lines: { message: string; meta?: Record<string, unknown> }[] = []
    const logger: IScopedLogger = {
      debug: () => {},
      info: (message, extras) =>
        lines.push({ message, ...(extras?.meta ? { meta: extras.meta } : {}) }),
      warn: () => {},
      error: () => {},
      child: () => logger,
      withTags: () => logger,
    }
    const tree = {
      roots: [
        {
          stepId: 'plate-detection',
          definition: plateDefinition,
          engine: plateEngine,
          modelId: 'yolox-tiny-plate',
          inputClasses: ['vehicle'],
          enabled: true,
          children: [
            {
              stepId: 'plate-ocr',
              definition: ocrDefinition,
              engine: ocrEngine,
              modelId: 'cct',
              inputClasses: ['plate'],
              enabled: true,
              children: [],
            },
          ],
        },
      ],
    }
    // A tiny box, so the reader's size floor logs the margin it cut with.
    const { result } = await new PipelineExecutor({ engineRuntime: 'onnx+cpu', logger }).run(
      tree,
      { kind: 'jpeg', data: await jpeg() },
      jpeg,
      W,
      H,
      1,
      {
        plane: 'full',
        suppliedRoot: {
          stepId: 'plate-detection',
          modelId: 'frigate-plus',
          detections: [{ bbox: [90, 90, 110, 96], score: 0.77 }],
        },
      },
    )
    expect(plateEngine.infer).not.toHaveBeenCalled()
    expect(result.detections[0]).toMatchObject({
      macroClass: 'plate',
      score: 0.77,
      rootSupplied: { stepId: 'plate-detection', modelId: 'frigate-plus' },
    })
    const skip = lines.find((l) => l.message === 'plate ROI too small for OCR — skipping')
    expect(skip?.meta).toMatchObject({
      marginFraction: ROOT_SUPPLIED_PLATE_MARGIN_FRACTION,
      boxFrom: 'root-model',
    })
  })
})
