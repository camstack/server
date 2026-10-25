/**
 * The runner's half of the MASK supply (D737) — a YOLO26-seg root standing in
 * for the `segmentation` step.
 *
 * The `segmentation` step is a frame-plane refiner: it runs its own model
 * once per detection crop, every frame, and writes a mask (plus the mask's
 * largest-component box as `refinedBbox`) onto the detection. A seg root's
 * decode already emits a mask with every detection, so when the camera's
 * mask supply is effective (`resolveRootSupply` — the same decision as every
 * other supply) the step is dropped from the dispatched tree and the root's
 * masks ARE its result, completed here into the step's exact shape. When the
 * supply is not in force the root's masks are not the camera's: the step's own
 * model provides them when it runs, and when it does not, they are removed so
 * nothing downstream receives masks the operator did not switch on.
 *
 * Pure: no I/O, no clock.
 */
import type {
  DetectionBoundingBox,
  FrameResult,
  ObjectDetection,
  PipelineStepInputOutput,
} from '@camstack/types'
import type { RootSupplyPlan } from './root-supply.js'

/** The frame-plane step a seg root supplies. */
export const SEGMENTATION_STEP_ID = 'segmentation'

/** What {@link applyMaskFill} did to the dispatched tree. */
export interface MaskFillOutcome {
  readonly steps: readonly PipelineStepInputOutput[]
  /** The root's own masks are this frame's segmentation result. */
  readonly filledByRoot: boolean
  /** The step runs its own model on this frame (its masks are its own). */
  readonly segmentationDispatched: boolean
}

/** Whether an ENABLED `stepId` is reachable through enabled ancestors. */
function dispatchesStep(steps: readonly PipelineStepInputOutput[], stepId: string): boolean {
  return steps.some(
    (s) =>
      s.enabled !== false &&
      (s.addonId === stepId || (s.children !== undefined && dispatchesStep(s.children, stepId))),
  )
}

function withoutStep(
  steps: readonly PipelineStepInputOutput[],
  stepId: string,
): readonly PipelineStepInputOutput[] {
  return steps
    .filter((s) => s.addonId !== stepId)
    .map((s) =>
      s.children !== undefined ? { ...s, children: withoutStep(s.children, stepId) } : s,
    )
}

/**
 * When the camera's mask supply is effective and the step would run, drop it
 * from the dispatch: the root's masks replace one inference per detection.
 * Otherwise the tree is returned untouched — a root that emits no masks (or a
 * flag the operator unchecked) leaves the step running its own model.
 */
export function applyMaskFill(
  steps: readonly PipelineStepInputOutput[],
  plan: RootSupplyPlan,
): MaskFillOutcome {
  const dispatched = dispatchesStep(steps, SEGMENTATION_STEP_ID)
  if (!dispatched || plan.states.get(SEGMENTATION_STEP_ID)?.effective !== true) {
    return { steps, filledByRoot: false, segmentationDispatched: dispatched }
  }
  return {
    steps: withoutStep(steps, SEGMENTATION_STEP_ID),
    filledByRoot: true,
    segmentationDispatched: false,
  }
}

/** `[x, y, w, h]` of the largest 4-connected foreground component, mask pixels. */
export type MaskComponentBox = readonly [number, number, number, number]

/**
 * The largest 4-connected non-zero component of a `width × height` byte mask —
 * the same reduction the `segmentation` step's decode applies to its own mask
 * (`saliency.py`). `null` when the mask has no foreground (or a size that does
 * not match its bytes).
 */
export function largestMaskComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): MaskComponentBox | null {
  const size = width * height
  if (!(size > 0) || mask.length < size) return null
  const visited = new Uint8Array(size)
  const stack = new Int32Array(size)
  let best: { area: number; box: MaskComponentBox } | null = null
  for (let start = 0; start < size; start++) {
    if (mask[start] === 0 || visited[start] === 1) continue
    visited[start] = 1
    let top = 0
    stack[top++] = start
    let area = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    while (top > 0) {
      const p = stack[--top]!
      area += 1
      const x = p % width
      const y = (p - x) / width
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      // Each pixel is pushed at most once (marked on push), so the stack
      // never outgrows the mask.
      if (x > 0 && visited[p - 1] === 0 && mask[p - 1] !== 0) {
        visited[p - 1] = 1
        stack[top++] = p - 1
      }
      if (x < width - 1 && visited[p + 1] === 0 && mask[p + 1] !== 0) {
        visited[p + 1] = 1
        stack[top++] = p + 1
      }
      if (y > 0 && visited[p - width] === 0 && mask[p - width] !== 0) {
        visited[p - width] = 1
        stack[top++] = p - width
      }
      if (y < height - 1 && visited[p + width] === 0 && mask[p + width] !== 0) {
        visited[p + width] = 1
        stack[top++] = p + width
      }
    }
    if (best === null || area > best.area) {
      best = { area, box: [minX, minY, maxX - minX + 1, maxY - minY + 1] }
    }
  }
  return best?.box ?? null
}

/**
 * The detection's `refinedBbox` from its own mask — the mapping the result
 * assembler applies to the `segmentation` step's `maskBbox`: the mask spans
 * the detection's box, so mask pixels scale linearly onto it.
 */
export function refinedBboxFromMask(detection: ObjectDetection): DetectionBoundingBox | undefined {
  const { mask, maskWidth, maskHeight, bbox } = detection
  if (mask === undefined || maskWidth === undefined || maskHeight === undefined) return undefined
  const component = largestMaskComponent(
    new Uint8Array(Buffer.from(mask, 'base64')),
    maskWidth,
    maskHeight,
  )
  if (component === null) return undefined
  const [mx, my, mw, mh] = component
  const sx = bbox.width / maskWidth
  const sy = bbox.height / maskHeight
  return { x: bbox.x + mx * sx, y: bbox.y + my * sy, width: mw * sx, height: mh * sy }
}

function withoutMask(detection: ObjectDetection): ObjectDetection {
  const { mask: _mask, maskWidth: _w, maskHeight: _h, ...rest } = detection
  if (rest.debug === undefined) return rest
  const { mask: _dm, maskWidth: _dw, maskHeight: _dh, ...debug } = rest.debug
  return { ...rest, debug }
}

/**
 * Apply the mask decision to a frame. Filled by the root ⇒ each root
 * detection's mask is completed with its `refinedBbox`, exactly what the
 * step would have written. The step ran ⇒ untouched (its own masks). Neither
 * ⇒ a seg root's masks are removed from the first-level detections. Never
 * mutates; returns the input when nothing changes.
 */
export function applyRootMasks(result: FrameResult, fill: MaskFillOutcome): FrameResult {
  if (fill.segmentationDispatched) return result
  let changed = false
  const detections = result.detections.map((d) => {
    if (d.kind !== 'first-level' || d.mask === undefined) return d
    if (!fill.filledByRoot) {
      changed = true
      return withoutMask(d)
    }
    if (d.refinedBbox !== undefined) return d
    const refinedBbox = refinedBboxFromMask(d)
    if (refinedBbox === undefined) return d
    changed = true
    return { ...d, refinedBbox }
  })
  return changed ? { ...result, detections } : result
}
