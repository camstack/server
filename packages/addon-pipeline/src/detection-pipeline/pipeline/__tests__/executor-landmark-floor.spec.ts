/**
 * The composition test — the one that pins the actual defect.
 *
 * `executor.ts` computed `gateShortSide = aligned.nativeFaceShortSidePx ??
 * detShortSide`, so the NATIVE measurement replaced the detection one the
 * moment the native path succeeded. A 20 px face in the detection frame that
 * cut to 100 px natively sailed straight through the 28 px floor and got
 * embedded — from landmarks regressed on 20 px, which is not enough to align
 * anything. Measured 2026-08-19, that is 62% of the crops reaching ArcFace.
 *
 * These specs drive the real `PipelineExecutor` with a native-crop provider
 * BOUND (the case that used to pass) and assert the embedding engine is never
 * invoked below the floor, and is invoked above it.
 */
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type {
  EngineOutput,
  IInferenceEngine,
  InferenceInput,
  ModelCatalogEntry,
  StepDefinition,
} from '@camstack/types'
import { PipelineExecutor } from '../executor.js'
import type { NativeFaceCropProvider } from '../face-align.js'
import type { ExecutableStep, ExecutableTree } from '../tree-builder.js'

const FRAME_W = 640
const FRAME_H = 480

function faceModel(): ModelCatalogEntry {
  return {
    id: 'stub-arcface',
    name: 'stub-arcface',
    description: '',
    formats: {},
    inputSize: { width: 112, height: 112 },
    labels: [],
    // The property that routes this child down the landmark-aligned branch.
    faceAlignment: true,
  }
}

const faceDetectorDefinition: StepDefinition = {
  id: 'test-face-detection',
  name: 'Test Face Detection',
  slot: 'detector',
  postprocessor: 'scrfd',
  extractMode: 'full-frame',
  inputClasses: null,
  outputClasses: ['face'],
  models: [
    {
      id: 'stub-scrfd',
      name: 'stub-scrfd',
      description: '',
      formats: {},
      inputSize: { width: 640, height: 640 },
      labels: [],
    },
  ],
  defaultModelId: 'stub-scrfd',
  defaultConfidence: 0,
}

const faceEmbeddingDefinition: StepDefinition = {
  id: 'test-face-embedding',
  name: 'Test Face Embedding',
  slot: 'classifier',
  postprocessor: 'arcface',
  extractMode: 'crop-roi',
  inputClasses: ['face'],
  outputClasses: ['identity'],
  models: [faceModel()],
  defaultModelId: 'stub-arcface',
  defaultConfidence: 0,
}

/** A square face bbox of `size` px centred in the frame, with 5 landmarks. */
function faceDetection(size: number) {
  const cx = FRAME_W / 2
  const cy = FRAME_H / 2
  const h = size / 2
  return {
    class: 'face',
    score: 0.95,
    bbox: [cx - h, cy - h, cx + h, cy + h] as [number, number, number, number],
    landmarks: [
      { x: cx - size * 0.2, y: cy - size * 0.1 },
      { x: cx + size * 0.2, y: cy - size * 0.1 },
      { x: cx, y: cy + size * 0.05 },
      { x: cx - size * 0.15, y: cy + size * 0.2 },
      { x: cx + size * 0.15, y: cy + size * 0.2 },
    ],
  }
}

async function frameJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: FRAME_W, height: FRAME_H, channels: 3, background: { r: 90, g: 90, b: 90 } },
  })
    .jpeg()
    .toBuffer()
}

/**
 * A native provider that always answers with a LARGE crop — the "native rescues
 * it" condition. If the landmark floor is respected, this must change nothing.
 */
function generousNativeProvider(): NativeFaceCropProvider {
  return vi.fn(async (_roi, _maxWidth) => {
    const w = 400
    const h = 400
    return { bytes: new Uint8Array(w * h * 3).fill(120), width: w, height: h }
  })
}

interface Harness {
  readonly tree: ExecutableTree
  readonly embedEngine: { infer: ReturnType<typeof vi.fn> }
}

function buildTree(faceSizePx: number, settings?: Record<string, unknown>): Harness {
  const detectorEngine = {
    runtime: 'onnx',
    device: 'cpu',
    dispose: async () => {},
    infer: vi.fn(
      async (_input: InferenceInput): Promise<EngineOutput> => ({
        structured: { kind: 'detections', detections: [faceDetection(faceSizePx)] },
        inferenceMs: 1,
      }),
    ),
  }

  const embedInfer = vi.fn(
    async (_input: InferenceInput): Promise<EngineOutput> => ({
      structured: { kind: 'embedding', embedding: [3, 4], embeddingNorm: [0.6, 0.8] },
      inferenceMs: 1,
    }),
  )
  const embedEngine = {
    runtime: 'onnx',
    device: 'cpu',
    dispose: async () => {},
    infer: embedInfer,
  }

  const child: ExecutableStep = {
    stepId: 'test-face-embedding',
    definition: faceEmbeddingDefinition,
    engine: embedEngine as unknown as IInferenceEngine,
    modelId: 'stub-arcface',
    inputClasses: ['face'],
    enabled: true,
    children: [],
    ...(settings !== undefined ? { settings } : {}),
  }

  const root: ExecutableStep = {
    stepId: 'test-face-detection',
    definition: faceDetectorDefinition,
    engine: detectorEngine as unknown as IInferenceEngine,
    modelId: 'stub-scrfd',
    inputClasses: [],
    enabled: true,
    children: [child],
  }

  return { tree: { roots: [root] }, embedEngine }
}

async function runWith(faceSizePx: number, settings?: Record<string, unknown>) {
  const { tree, embedEngine } = buildTree(faceSizePx, settings)
  const executor = new PipelineExecutor({ engineRuntime: 'test' })
  const jpeg = await frameJpeg()
  await executor.run(
    tree,
    { kind: 'jpeg', data: jpeg },
    async () => jpeg,
    FRAME_W,
    FRAME_H,
    /* deviceId */ 102,
    undefined,
    generousNativeProvider(),
  )
  return embedEngine.infer
}

describe('executor — landmark-precision floor', () => {
  it('does NOT embed a 20px detection face even though the native crop is 400px', async () => {
    const infer = await runWith(20)
    expect(infer).not.toHaveBeenCalled()
  })

  it('DOES embed a 25px detection face', async () => {
    const infer = await runWith(25)
    expect(infer).toHaveBeenCalled()
  })

  it('honours an operator-lowered floor', async () => {
    const infer = await runWith(20, { minLandmarkFaceSize: 16 })
    expect(infer).toHaveBeenCalled()
  })

  it('a floor of 0 disables the gate entirely', async () => {
    const infer = await runWith(10, { minLandmarkFaceSize: 0, minFaceSize: 0 })
    expect(infer).toHaveBeenCalled()
  })
})

// D731: a root face is re-found in its refinement square and handed back
// to the face step as `suppliedRoot`. The landmark floor then measures the face
// in the REFINEMENT input (the face fills ~60% of the 160 px region), not in
// the detection frame where the root saw it small — that is the whole point of
// refining, and the floor still refuses a refined face that is itself tiny.
describe('executor — landmark-precision floor on a refined root face', () => {
  async function runSupplied(faceSizePx: number) {
    const { tree, embedEngine } = buildTree(faceSizePx)
    const detectorInfer = tree.roots[0]?.engine.infer
    const face = faceDetection(faceSizePx)
    const executor = new PipelineExecutor({ engineRuntime: 'test' })
    const jpeg = await frameJpeg()
    await executor.run(
      tree,
      { kind: 'jpeg', data: jpeg },
      async () => jpeg,
      FRAME_W,
      FRAME_H,
      102,
      {
        plane: 'full',
        suppliedRoot: {
          stepId: 'test-face-detection',
          modelId: 'stub-scrfd',
          detections: [{ bbox: face.bbox, score: face.score, landmarks: face.landmarks }],
        },
      },
      generousNativeProvider(),
    )
    return { embed: embedEngine.infer, detectorInfer }
  }

  it('embeds a refined face measured at its refinement size, without re-running the detector', async () => {
    const { embed, detectorInfer } = await runSupplied(100)
    expect(detectorInfer).not.toHaveBeenCalled()
    expect(embed).toHaveBeenCalled()
  })

  it('still refuses a refined face that is below the floor in the refinement input', async () => {
    const { embed } = await runSupplied(20)
    expect(embed).not.toHaveBeenCalled()
  })
})
