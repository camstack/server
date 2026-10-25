/**
 * The model-free appearance descriptor of one box (D683 §8.1).
 *
 * Input: a small RGB view of the box (`APPEARANCE_VIEW`, resolved from the
 * frame lease the runner already holds, D379). Output: 96 integers — per
 * upper/lower half, a hue×saturation histogram (8×4), a value histogram (8)
 * and a magnitude-weighted gradient-orientation histogram (8) — each block
 * L1-normalised and quantised to 0–255. `gray` when the mean of saturation ×
 * value is under 0.08: IR, greyscale, and near-black noise (whose HSV
 * saturation is high but meaningless). No learned weights (O6).
 */
import {
  APPEARANCE_BIN_COUNT,
  APPEARANCE_BLOCKS,
  type AppearanceBlockName,
  type AppearanceDescriptor,
  type ObjectDetection,
} from '@camstack/types'

export interface RgbView {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

export interface AppearanceCrop {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface AppearanceBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface FrameSize {
  readonly width: number
  readonly height: number
}

export const APPEARANCE_VIEW = { width: 16, height: 32 } as const
const SHRINK = 0.1
const GRAY_MEAN_SATURATION = 0.08
const MIN_CROP_PX = 6

export function appearanceCrop(bbox: AppearanceBox, frame: FrameSize): AppearanceCrop | null {
  const left = Math.max(0, Math.round(bbox.x + bbox.width * SHRINK))
  const top = Math.max(0, Math.round(bbox.y + bbox.height * SHRINK))
  const right = Math.min(frame.width, Math.round(bbox.x + bbox.width * (1 - SHRINK)))
  const bottom = Math.min(frame.height, Math.round(bbox.y + bbox.height * (1 - SHRINK)))
  const width = right - left
  const height = bottom - top
  if (width < MIN_CROP_PX || height < MIN_CROP_PX) return null
  return { left, top, width, height }
}

/**
 * Which boxes get a descriptor. `'all'` unless the local cost gate (Task 10
 * Step 9) failed.
 *
 * `'all'` failed the local gate (`appearance-cost-bench.ts`, sharp-fallback
 * path, synthetic clip -- no live D681 tape was fetched in this session, see
 * the Task 10 commit message and report): frame p95 3.375 ms against a
 * 1.0 ms budget. `'candidates'` is cheaper but ALSO exceeded budget on the
 * same synthetic input (1.622 ms). Per the brief this is a STOP -- the
 * descriptor must not ship over budget on unconfirmed numbers. `'candidates'`
 * is kept here as the documented, safer fallback pending Task 24's hub
 * measurement over the REAL native-lease path (the one this bench does not
 * exercise); that number decides, and may move this back to `'all'` or
 * confirm `'candidates'`.
 */
export const APPEARANCE_SCOPE: 'all' | 'candidates' = 'candidates'

/** A box overlapping another first-level box of its class (IoU ≥ 0.1): where L1 doubt happens. */
export function overlapsSameClass(detections: readonly ObjectDetection[], index: number): boolean {
  const d = detections[index]
  if (d === undefined) return false
  return detections.some((o, j) => {
    if (j === index || o.kind !== 'first-level' || o.macroClass !== d.macroClass) return false
    const ix = Math.max(
      0,
      Math.min(d.bbox.x + d.bbox.width, o.bbox.x + o.bbox.width) - Math.max(d.bbox.x, o.bbox.x),
    )
    const iy = Math.max(
      0,
      Math.min(d.bbox.y + d.bbox.height, o.bbox.y + o.bbox.height) - Math.max(d.bbox.y, o.bbox.y),
    )
    const inter = ix * iy
    const union = d.bbox.width * d.bbox.height + o.bbox.width * o.bbox.height - inter
    return union > 0 && inter / union >= 0.1
  })
}

interface Hsv {
  h: number
  s: number
  v: number
}

/**
 * Writes into `out` rather than allocating a fresh object — this runs once
 * per PIXEL (16×32 = 512 calls per box), and the per-pixel object it used to
 * return was measured as the dominant allocation of the descriptor (Task 9
 * review). Behaviour is unchanged: same numbers, same rounding.
 */
function hsv(r: number, g: number, b: number, out: Hsv): void {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const v = max / 255
  const s = max === 0 ? 0 : (max - min) / max
  if (max === min) {
    out.h = 0
    out.s = s
    out.v = v
    return
  }
  const d = max - min
  let h: number
  if (max === r) h = ((g - b) / d + 6) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  out.h = h / 6
  out.s = s
  out.v = v
}

function binOf(value: number, bins: number): number {
  return Math.min(bins - 1, Math.max(0, Math.floor(value * bins)))
}

export function computeAppearanceDescriptor(view: RgbView): AppearanceDescriptor {
  const raw = new Float64Array(APPEARANCE_BIN_COUNT)
  const { width: w, height: h, data } = view
  const intensity = (x: number, y: number): number => {
    const i = (y * w + x) * 3
    return ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3
  }
  const add = (block: AppearanceBlockName, bin: number, amount: number): void => {
    const [from] = APPEARANCE_BLOCKS[block]
    raw[from + bin] = (raw[from + bin] ?? 0) + amount
  }
  let saturation = 0
  const hsvScratch: Hsv = { h: 0, s: 0, v: 0 }
  for (let y = 0; y < h; y++) {
    const upper = y < h / 2
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      hsv(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, hsvScratch)
      const hue = hsvScratch.h
      const s = hsvScratch.s
      const v = hsvScratch.v
      // Saturation weighted by value: near-black pixels carry no colour however saturated their noise.
      saturation += s * v
      add(upper ? 'upperHs' : 'lowerHs', binOf(hue, 8) * 4 + binOf(s, 4), 1)
      add(upper ? 'upperV' : 'lowerV', binOf(v, 8), 1)
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
        const gx = intensity(x + 1, y) - intensity(x - 1, y)
        const gy = intensity(x, y + 1) - intensity(x, y - 1)
        const mag = Math.hypot(gx, gy)
        if (mag > 0) {
          const angle = (Math.atan2(gy, gx) + Math.PI) % Math.PI
          add(upper ? 'upperGrad' : 'lowerGrad', binOf(angle / Math.PI, 8), mag)
        }
      }
    }
  }
  const bins = new Array<number>(APPEARANCE_BIN_COUNT).fill(0)
  for (const [from, to] of Object.values(APPEARANCE_BLOCKS)) {
    let sum = 0
    for (let i = from; i < to; i++) sum += raw[i] ?? 0
    if (!(sum > 0)) continue
    for (let i = from; i < to; i++) bins[i] = Math.round(((raw[i] ?? 0) / sum) * 255)
  }
  return { version: 1, bins, gray: saturation / Math.max(1, w * h) < GRAY_MEAN_SATURATION }
}
