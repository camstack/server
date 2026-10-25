/**
 * The tree photo enrolment sends, run through the executor with the REAL
 * catalog definitions.
 *
 * `addon-post-analysis`'s `photo.analyze` posts ONE step tree to
 * `pipelineExecutor.runPipeline` on the `'full'` plane —
 * `face-detection` as a ROOT with `face-embedding` nested under it — and then
 * reads `embedding`, `embeddingModelId` and `faceAlignedCrop` off the returned
 * `face` detections. Everything downstream of that (the sample, its model
 * stamp, its blobs) is built on those three fields being there.
 *
 * `executor-root-details.spec.ts` already pins the SHAPE of that nesting, but
 * it does so with hand-written definitions — and the hand-written face root it
 * uses declares `extractMode: 'full-frame'` while the real `face-detection`
 * declares `crop-roi`, and the real one carries a cadence, a
 * `defaultMinParentScore` and a `minLandmarkFaceSize` schema the fake does not.
 * A fake that is kinder than production is exactly how this repo has twice had
 * a green test over a live bug, so this spec pulls the definitions out of
 * `getStepDefinition` and asserts the same thing against them.
 *
 * It also pins the ONE property the enrolment path depends on that is easy to
 * regress silently: a face too small in the DETECTION space gets no embedding
 * at all rather than a badly-aligned one. That refusal is what the operator
 * sees as "not usable", and if it ever became a plain-crop fallback the gallery
 * would start accepting samples that match everybody.
 */
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { EngineOutput, IInferenceEngine, InferenceInput } from '@camstack/types'
import { getStepDefinition } from '../../registry/step-definitions.js'
import { PipelineExecutor } from '../executor.js'
import type { ExecutableStep, ExecutableTree } from '../tree-builder.js'

/** A photograph, not a detection frame: big enough that a face clears the floors. */
const PHOTO_WIDTH = 1200
const PHOTO_HEIGHT = 900

/** The step ids `photo-enrollment.ts` names. Spelled out, not imported across
 *  the package boundary — if either id is renamed this spec must go red. */
const FACE_DETECTION_STEP_ID = 'face-detection'
const FACE_EMBEDDING_STEP_ID = 'face-embedding'

function faceBox(x: number, y: number, size: number): readonly [number, number, number, number] {
  return [x, y, x + size, y + size]
}

function landmarksIn(
  x: number,
  y: number,
  size: number,
): readonly { readonly x: number; readonly y: number }[] {
  return [
    { x: x + size * 0.3, y: y + size * 0.35 },
    { x: x + size * 0.7, y: y + size * 0.35 },
    { x: x + size * 0.5, y: y + size * 0.55 },
    { x: x + size * 0.35, y: y + size * 0.75 },
    { x: x + size * 0.65, y: y + size * 0.75 },
  ]
}

function stubEngine(output: EngineOutput): IInferenceEngine {
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(async (_input: InferenceInput): Promise<EngineOutput> => output),
    dispose: async () => {},
  }
}

async function makePhotoJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: PHOTO_WIDTH,
      height: PHOTO_HEIGHT,
      channels: 3,
      background: { r: 120, g: 110, b: 100 },
    },
  })
    .jpeg()
    .toBuffer()
}

/**
 * The REAL catalog entries, wired exactly as `photo.analyze` sends them.
 *
 * The embedder's model entry is overridden to a stub id so no ONNX file is
 * needed — but `faceAlignment: true` and `inputSize` are taken from the real
 * `arcface-r100` entry, because those two are what select the alignment branch
 * and the 112² template. Everything else (slot, extractMode, inputClasses,
 * postprocessor, the config schema the executor reads `minLandmarkFaceSize`
 * from) is production's.
 */
function buildPhotoTree(
  detectorOutput: EngineOutput,
  embeddingOutput: EngineOutput,
): ExecutableTree {
  const detectorDef = getStepDefinition(FACE_DETECTION_STEP_ID)
  const embedderDef = getStepDefinition(FACE_EMBEDDING_STEP_ID)
  const realArcface = embedderDef.models.find((m) => m.id === embedderDef.defaultModelId)
  expect(realArcface?.faceAlignment).toBe(true)

  const child: ExecutableStep = {
    stepId: embedderDef.id,
    definition: {
      ...embedderDef,
      models: [{ ...realArcface!, id: 'stub-face-embedder', formats: {} }],
      defaultModelId: 'stub-face-embedder',
    },
    engine: stubEngine(embeddingOutput),
    modelId: 'stub-face-embedder',
    inputClasses: embedderDef.inputClasses ?? [],
    enabled: true,
    children: [],
  }
  const root: ExecutableStep = {
    stepId: detectorDef.id,
    definition: detectorDef,
    engine: stubEngine(detectorOutput),
    modelId: detectorDef.defaultModelId,
    inputClasses: detectorDef.inputClasses ?? [],
    enabled: true,
    children: [child],
  }
  return { roots: [root] }
}

async function runPhoto(tree: ExecutableTree) {
  const photo = await makePhotoJpeg()
  const executor = new PipelineExecutor({ engineRuntime: 'onnx+cpu' })
  const { result } = await executor.run(
    tree,
    { kind: 'jpeg', data: photo },
    vi.fn(async () => photo),
    PHOTO_WIDTH,
    PHOTO_HEIGHT,
    // Enrolment photos are not tied to a live camera row — device 0 is the sentinel.
    0,
    { plane: 'full' },
  )
  return result
}

describe('the photo-enrolment tree, against the REAL catalog', () => {
  it('is shaped the way the enrolment path assumes', () => {
    const detector = getStepDefinition(FACE_DETECTION_STEP_ID)
    const embedder = getStepDefinition(FACE_EMBEDDING_STEP_ID)
    // The root is a DETECTOR-shaped step whose output the executor treats as
    // detections; a non-detections root would take the synthesize branch and
    // produce one full-frame "face" instead of the real ones.
    expect(detector.postprocessor).toBe('scrfd')
    expect(detector.outputClasses).toContain('face')
    // The child attaches to `face`, which is what makes the nesting legal.
    expect(embedder.inputClasses).toContain('face')
    // CLUSTER-scoped: the enrolment sends no modelId precisely because the
    // runner overwrites it from the cluster row (D199). If this ever became
    // node-scoped, photo samples would silently be stamped per node.
    expect(embedder.modelScope).toBe('cluster')
  })

  it('yields one face per detection, each with its vector, its model and its exact template', async () => {
    const a = faceBox(200, 150, 220)
    const b = faceBox(700, 180, 180)
    const result = await runPhoto(
      buildPhotoTree(
        {
          inferenceMs: 1,
          structured: {
            kind: 'detections',
            detections: [
              { class: 'face', score: 0.97, bbox: a, landmarks: landmarksIn(200, 150, 220) },
              { class: 'face', score: 0.91, bbox: b, landmarks: landmarksIn(700, 180, 180) },
            ],
          },
        },
        {
          inferenceMs: 1,
          structured: { kind: 'embedding', embedding: [3, 4], embeddingNorm: [0.6, 0.8] },
        },
      ),
    )

    const faces = result.detections.filter((d) => d.macroClass === 'face')
    expect(faces).toHaveLength(2)
    for (const face of faces) {
      // The three fields `analyzePhotoFaces` reads. All three, or the face is
      // reported to the operator as not usable.
      expect(face.embedding).toEqual([0.6, 0.8])
      expect(face.embeddingModelId).toBe('stub-face-embedder')
      expect(typeof face.faceAlignedCrop).toBe('string')
    }
    // Two DISTINCT faces, not one detail duplicated: a family photo is the
    // whole point, and a tree that collapsed them would look like it worked.
    expect(new Set(faces.map((f) => JSON.stringify(f.bbox))).size).toBe(2)
  })

  it('the aligned template really is the canonical 112 square, not a bbox cutout', async () => {
    const result = await runPhoto(
      buildPhotoTree(
        {
          inferenceMs: 1,
          structured: {
            kind: 'detections',
            detections: [
              {
                class: 'face',
                score: 0.95,
                bbox: faceBox(300, 200, 240),
                landmarks: landmarksIn(300, 200, 240),
              },
            ],
          },
        },
        { inferenceMs: 1, structured: { kind: 'embedding', embedding: [1], embeddingNorm: [1] } },
      ),
    )
    const crop = result.detections.find((d) => d.macroClass === 'face')?.faceAlignedCrop
    expect(crop).toBeDefined()
    const meta = await sharp(Buffer.from(crop!, 'base64')).metadata()
    // 112x112 is the ArcFace input. A 240px square bbox cutout would be 240x240
    // — which is what a "plausible but useless" sample looks like from outside.
    expect(meta.width).toBe(112)
    expect(meta.height).toBe(112)
  })

  it('refuses to embed a face too small in the DETECTION space rather than aligning it badly', async () => {
    // 20 px in the space the detector ran in. Two floors stand in the way and
    // the landmark-precision one (24 px, `landmark-precision-gate.ts`) fires
    // first; the size floor (28 px) is behind it. Either way the face is still
    // DETECTED — the operator sees it — and simply carries no vector, which is
    // what `analyzePhotoFaces` reports as `no-embedding`. What must never
    // happen is the plain-crop fallback: a badly aligned template scores HIGH
    // against everybody and no threshold downstream can catch it.
    const result = await runPhoto(
      buildPhotoTree(
        {
          inferenceMs: 1,
          structured: {
            kind: 'detections',
            detections: [
              {
                class: 'face',
                score: 0.8,
                bbox: faceBox(500, 400, 20),
                landmarks: landmarksIn(500, 400, 20),
              },
            ],
          },
        },
        { inferenceMs: 1, structured: { kind: 'embedding', embedding: [1], embeddingNorm: [1] } },
      ),
    )
    const face = result.detections.find((d) => d.macroClass === 'face')
    expect(face).toBeDefined()
    expect(face?.embedding).toBeUndefined()
    expect(face?.faceAlignedCrop).toBeUndefined()
  })
})
