/**
 * D737 in the executor: a YOLO26-seg ROOT yields the plain detector's
 * detections — same classMap, same per-macro thresholds, same discard trail —
 * and each surviving detection keeps the mask its decode emitted.
 */
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { COCO_TO_MACRO, rootSuppliesOf } from '@camstack/types'
import type {
  EngineOutput,
  FrameResult,
  IInferenceEngine,
  InferenceInput,
  ObjectDetection,
} from '@camstack/types'
import { getStepDefinition } from '../../registry/step-definitions.js'
import { PipelineExecutor } from '../executor.js'
import type { ExecutableStep } from '../tree-builder.js'

const W = 640
const H = 360
const OD = getStepDefinition('object-detection')

function engine(output: EngineOutput): IInferenceEngine {
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

const MASK = Buffer.from(Uint8Array.from([0, 255, 255, 255, 255, 0])).toString('base64')

/** One frame's decoded boxes: a person, a dog, a weak car, a chair (unmapped). */
const BOXES = [
  { class: 'person', score: 0.9, bbox: [100, 40, 180, 300] },
  { class: 'dog', score: 0.7, bbox: [300, 200, 380, 280] },
  { class: 'car', score: 0.2, bbox: [400, 100, 600, 220] },
  { class: 'chair', score: 0.8, bbox: [10, 10, 60, 60] },
] as const

async function runRoot(modelId: string, withMasks: boolean): Promise<FrameResult> {
  const model = OD.models.find((m) => m.id === modelId)
  if (model === undefined) throw new Error(`${modelId} is not an object-detection model`)
  const step: ExecutableStep = {
    stepId: OD.id,
    definition: OD,
    engine: engine({
      inferenceMs: 1,
      structured: {
        kind: 'detections',
        detections: BOXES.map((b) => ({
          ...b,
          bbox: [...b.bbox],
          ...(withMasks ? { mask: MASK, maskWidth: 3, maskHeight: 2 } : {}),
        })),
      },
    }),
    modelId,
    inputClasses: [],
    enabled: true,
    children: [],
    settings: { enabledMacroClasses: ['person', 'vehicle', 'animal'], minConfidenceVehicle: 0.5 },
    effectiveClassMap: COCO_TO_MACRO,
    rootSupplies: rootSuppliesOf(model, { labels: OD.labels ?? [], classMap: COCO_TO_MACRO }),
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

function boxesOf(
  result: FrameResult,
): readonly Pick<ObjectDetection, 'macroClass' | 'score' | 'bbox'>[] {
  return result.detections.map((d) => ({ macroClass: d.macroClass, score: d.score, bbox: d.bbox }))
}

describe('a seg root detects exactly like the plain detector, plus masks', () => {
  it('the seg build is an object-detection model whose decode emits masks', () => {
    const seg = OD.models.find((m) => m.id === 'yolo26n-seg')
    expect(seg?.postprocessor).toBe('yolo-seg')
    expect(
      rootSuppliesOf(seg, { labels: OD.labels ?? [], classMap: COCO_TO_MACRO }).map(
        (s) => s.stepId,
      ),
    ).toEqual(['animal-classifier', 'vehicle-classifier', 'segmentation'])
  })

  it('identical detections and discard trail; each detection keeps its mask', async () => {
    const plain = await runRoot('yolo26n', false)
    const seg = await runRoot('yolo26n-seg', true)
    expect(boxesOf(seg)).toEqual(boxesOf(plain))
    expect(seg.discarded).toEqual(plain.discarded)
    expect(boxesOf(seg).map((d) => d.macroClass)).toEqual(['person', 'animal'])
    for (const d of seg.detections) {
      expect(d).toMatchObject({ mask: MASK, maskWidth: 3, maskHeight: 2 })
    }
    for (const d of plain.detections) expect(d.mask).toBeUndefined()
  })
})
