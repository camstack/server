/**
 * crop-zone extractMode (`package-detection`) frame-prep in the executor.
 *
 * When a ROOT step declares `extractMode: 'crop-zone'` and the caller supplies
 * a crop bbox, the executor must:
 *   1. run inference on the CROPPED frame (not the full frame), and
 *   2. re-project the detector's crop-relative bboxes back to full-frame coords
 *      so the zone / notifier logic downstream sees absolute coordinates.
 *
 * Without a crop bbox (benchmark / no zones) the same step runs full-frame,
 * unchanged. See docs/superpowers/specs/2026-07-17-package-zones-design.md
 * (ADDENDUM 2026-07-17 — crop-zone).
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
import type { AbsoluteBbox } from '../crop-utils.js'

const FRAME_WIDTH = 400
const FRAME_HEIGHT = 300

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

const packageStepDefinition: StepDefinition = {
  id: 'package-detection',
  name: 'Package Detection',
  slot: 'detector',
  postprocessor: 'yolo',
  extractMode: 'crop-zone',
  inputClasses: null,
  outputClasses: ['package'],
  models: [makeModelEntry('stub-package-model')],
  defaultModelId: 'stub-package-model',
  defaultConfidence: 0.5,
  labels: ['package'],
}

/** Records the pixel dimensions of every JPEG the engine is asked to infer. */
interface CapturingEngine {
  engine: IInferenceEngine
  sizes: { width: number; height: number }[]
}

function makeCapturingEngine(output: EngineOutput): CapturingEngine {
  const sizes: { width: number; height: number }[] = []
  const engine: IInferenceEngine = {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(async (input: InferenceInput): Promise<EngineOutput> => {
      if (input.kind === 'jpeg') {
        const meta = await sharp(input.data).metadata()
        sizes.push({ width: meta.width ?? 0, height: meta.height ?? 0 })
      }
      return output
    }),
    dispose: async () => {},
  }
  return { engine, sizes }
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

function buildTree(engine: IInferenceEngine): ExecutableTree {
  const rootStep: ExecutableStep = {
    stepId: packageStepDefinition.id,
    definition: packageStepDefinition,
    engine,
    modelId: packageStepDefinition.defaultModelId,
    inputClasses: [],
    enabled: true,
    children: [],
  }
  return { roots: [rootStep] }
}

/** A crop-relative detection the stub engine emits, unaffected by input. */
const CROP_RELATIVE_DETECTION = { class: 'package', score: 0.9, bbox: [10, 20, 40, 60] as const }

function stubOutput(): EngineOutput {
  return {
    inferenceMs: 1,
    structured: { kind: 'detections', detections: [CROP_RELATIVE_DETECTION] },
  }
}

describe('PipelineExecutor — crop-zone root frame prep', () => {
  it('crops inference to the zone bbox and re-projects detections to full frame', async () => {
    const { engine, sizes } = makeCapturingEngine(stubOutput())
    const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })
    // Zone crop occupying the middle of the frame.
    const cropBbox: AbsoluteBbox = [100, 60, 300, 220]

    const { result } = await executor.run(
      buildTree(engine),
      { kind: 'jpeg', data: await makeFrameJpeg() },
      vi.fn(makeFrameJpeg),
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      { plane: 'frame' },
      undefined,
      cropBbox,
    )

    // (1) inference ran on the CROP, not the full frame.
    expect(sizes).toHaveLength(1)
    expect(sizes[0]).toEqual({ width: 200, height: 160 })

    // (2) the crop-relative bbox is shifted by the crop origin (100, 60).
    expect(result.detections).toHaveLength(1)
    const det = result.detections[0]!
    expect(det.macroClass).toBe('package')
    expect(det.bbox).toEqual({ x: 110, y: 80, width: 30, height: 40 })
  })

  it('runs full-frame (no crop, no re-projection) when no crop bbox is supplied', async () => {
    const { engine, sizes } = makeCapturingEngine(stubOutput())
    const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })

    const { result } = await executor.run(
      buildTree(engine),
      { kind: 'jpeg', data: await makeFrameJpeg() },
      vi.fn(makeFrameJpeg),
      FRAME_WIDTH,
      FRAME_HEIGHT,
      1,
      { plane: 'frame' },
      // no nativeFaceCropProvider, no cropZoneBbox
    )

    // Inference saw the full frame; bbox is unshifted (raw crop-relative == full).
    expect(sizes[0]).toEqual({ width: FRAME_WIDTH, height: FRAME_HEIGHT })
    expect(result.detections[0]!.bbox).toEqual({ x: 10, y: 20, width: 30, height: 40 })
  })
})
