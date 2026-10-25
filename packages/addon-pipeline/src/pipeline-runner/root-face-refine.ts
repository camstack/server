/**
 * Root face refinement (D731) — how a ROOT model's `face` box becomes a face
 * the recogniser can use, without ever embedding an unaligned crop.
 *
 * A root face box has no landmarks. It is used as a LOCATION only:
 *
 *  1. one face-scoped square around it (`deriveRootFaceRefineRect`, box ×1.6)
 *     is cut from the frame's NATIVE surface — the native lease or nothing;
 *  2. the square is shrunk to {@link ROOT_FACE_REFINE_INPUT_PX} and laid in the
 *     top-left of a black canvas the size of the face detector's input, so the
 *     detector runs at an effective 160 px input on its own 640 graph — the
 *     network is convolutional, the black margin contains nothing, and no 160 px
 *     build of the model is needed. The canvas maps back to the frame through
 *     a "virtual" frame rectangle 640/160 times the square, so every existing
 *     crop→frame mapping (results, native child re-cuts) stays exact;
 *  3. the detector's best face in the square is kept — its landmarks come from
 *     the refinement input, where the face is large, which is the space the
 *     landmark-precision gate then measures it in;
 *  4. that face is handed back to the SAME step as its output
 *     (`suppliedRoot`), so the embedder child aligns it through the existing
 *     native-crop alignment, exactly like a detected face.
 *
 * No face in the square ⇒ nothing is embedded, and the drop is logged.
 */
import {
  deriveRootFaceRefineRect,
  type DetailResult,
  type FrameHandle,
  type ObjectDetection,
  type PipelineStepInputOutput,
  ROOT_FACE_REFINE_INPUT_PX,
  type RunDetailSubtreeInput,
  type SuppliedRootOutput,
} from '@camstack/types'
import { getStepDefinition } from '../detection-pipeline/registry/step-definitions.js'
import { getSharp } from '../shared/lazy-sharp.js'
import {
  type CropSource,
  type DetailSubtreeDeps,
  isNativeCropMiss,
  normalizeRect,
  pruneChildStepsToRequested,
  toDetailResult,
} from './detail-subtree.js'

type SuppliedBoxes = NonNullable<RunDetailSubtreeInput['supplied']>

/** The face detector's input side for the step as it will run. */
export function detectorInputPx(step: PipelineStepInputOutput): number {
  const def = getStepDefinition(step.addonId)
  const modelId = step.modelId ?? def.defaultModelId
  const entry = def.models.find((m) => m.id === modelId)
  return entry?.inputSize.width ?? ROOT_FACE_REFINE_INPUT_PX
}

/** Lay the refinement square, shrunk to the refine input, on a black canvas. */
export async function buildRefineCanvas(squareJpeg: Buffer, canvasPx: number): Promise<Buffer> {
  const sharp = await getSharp()
  const small = await sharp(squareJpeg)
    .resize(ROOT_FACE_REFINE_INPUT_PX, ROOT_FACE_REFINE_INPUT_PX, { fit: 'fill' })
    .toBuffer()
  const pad = Math.max(0, canvasPx - ROOT_FACE_REFINE_INPUT_PX)
  return sharp(small)
    .extend({ top: 0, left: 0, bottom: pad, right: pad, background: { r: 0, g: 0, b: 0 } })
    .jpeg({ quality: 92 })
    .toBuffer()
}

/** The best face of a refinement pass, or `undefined` when it found none. */
export function bestFace(detections: readonly ObjectDetection[]): ObjectDetection | undefined {
  return detections
    .filter((d) => d.macroClass === 'face')
    .reduce<ObjectDetection | undefined>(
      (best, d) => (best === undefined || d.score > best.score ? d : best),
      undefined,
    )
}

/** The canvas-space face as the step's own output for the second pass. */
export function refinedAsSupplied(
  face: ObjectDetection,
  stepId: string,
  modelId: string,
): SuppliedRootOutput {
  return {
    stepId,
    modelId,
    detections: [
      {
        bbox: [
          face.bbox.x,
          face.bbox.y,
          face.bbox.x + face.bbox.width,
          face.bbox.y + face.bbox.height,
        ],
        score: face.score,
        ...(face.landmarks !== undefined
          ? { landmarks: face.landmarks.map((p) => ({ x: p.x, y: p.y })) }
          : {}),
      },
    ],
  }
}

/**
 * Refine the root's face box for one step and run the requested chain on the
 * face it finds. `null` ⇒ no pixels (the native lease is the only source);
 * an empty list ⇒ the square held no face. Every drop is logged.
 */
export async function refineRootFace(
  deps: Pick<DetailSubtreeDeps, 'getNativeCrop' | 'runPipeline' | 'logger'>,
  input: RunDetailSubtreeInput,
  supplied: SuppliedBoxes,
  step: PipelineStepInputOutput,
  requested: readonly string[] | undefined,
  deviceKey: string | undefined,
): Promise<readonly DetailResult[] | null> {
  const handle: FrameHandle | undefined = input.frameHandle
  const tags = { deviceId: input.deviceId }
  if (handle === undefined) {
    deps.logger.warn('root face refinement needs the native frame — no frame handle, dropped', {
      tags,
      meta: { stepId: step.addonId },
    })
    return null
  }
  const box = supplied.boxes.reduce((best, b) => (b.score > best.score ? b : best))
  const square = deriveRootFaceRefineRect(box.bbox, handle.width, handle.height)
  const native = await deps.getNativeCrop(
    input.deviceId,
    handle,
    normalizeRect(square, handle.width, handle.height),
  )
  if (native === null || isNativeCropMiss(native)) {
    deps.logger.warn('root face refinement: the native square missed — dropped', {
      tags,
      meta: {
        stepId: step.addonId,
        nativeMissReason: native === null ? null : native.miss,
      },
    })
    return null
  }
  const canvasPx = detectorInputPx(step)
  const scale = canvasPx / ROOT_FACE_REFINE_INPUT_PX
  // The canvas maps onto the frame as a rectangle `scale` times the square,
  // anchored at the square's origin — the 160 px region IS the square.
  const virtualFrameSpace = {
    x: native.frameSpace.x,
    y: native.frameSpace.y,
    w: native.frameSpace.w * scale,
    h: native.frameSpace.h * scale,
  }
  const crop: CropSource = {
    jpeg: await buildRefineCanvas(native.jpeg, canvasPx),
    width: canvasPx,
    height: canvasPx,
    frameSpace: virtualFrameSpace,
    source: 'native',
  }
  const nativeCropRef = { handle, cropFrameSpace: virtualFrameSpace }

  const detectorOnly: PipelineStepInputOutput = { ...step, children: [] }
  const found = await deps.runPipeline(
    [detectorOnly],
    crop.jpeg,
    input.deviceId,
    deviceKey,
    nativeCropRef,
  )
  const face = found === null ? undefined : bestFace(found.detections)
  if (face === undefined) {
    deps.logger.warn(
      'root face refinement found no face in the square — dropped, never embedded unaligned',
      {
        tags,
        meta: { stepId: step.addonId, rootModelId: supplied.modelId, rootScore: box.score },
      },
    )
    return []
  }

  const chain = requested === undefined ? step : pruneChildStepsToRequested(step, requested)
  if (chain.children === undefined || chain.children.length === 0) {
    return [toDetailResult(face, step.addonId, crop)]
  }
  const modelId = step.modelId ?? getStepDefinition(step.addonId).defaultModelId
  const embedded = await deps.runPipeline(
    [chain],
    crop.jpeg,
    input.deviceId,
    deviceKey,
    nativeCropRef,
    refinedAsSupplied(face, step.addonId, modelId),
  )
  if (embedded === null) return [toDetailResult(face, step.addonId, crop)]
  return embedded.detections.map((d) => toDetailResult(d, step.addonId, crop))
}
