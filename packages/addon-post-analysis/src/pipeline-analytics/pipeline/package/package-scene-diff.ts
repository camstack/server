/**
 * Zone-crop scene difference for a packages rule (D931).
 *
 * A uniform brightness shift is removed by subtracting the median luma delta,
 * so a shadow that lifts the whole crop leaves no blob. What remains is a
 * connected region. The package model is not consulted here.
 */

import type { StationaryBbox } from '../stationary/stationary-types.js'

/** Residual, after the median shift, that counts as a changed pixel. */
export const PACKAGE_SCENE_DIFF_LUMA_THRESHOLD = 28

/** A changed region this large, relative to the zone, is the zone itself. */
export const PACKAGE_SCENE_DIFF_MAX_CHANGED_FRAC = 0.45

/** How much of a blob an occluder must cover before the blob is not a parcel. */
export const PACKAGE_SCENE_DIFF_OCCLUDE_FRAC = 0.2

/** Mean luma change inside a blob, look to look, that still counts as "still". */
export const PACKAGE_SCENE_DIFF_STABLE_MEAN = 12

/** Wait this long after the person leaves before the first comparison. */
export const PACKAGE_SCENE_DIFF_SETTLE_MS = 3_000

/** Spacing between the looks that confirm a blob stayed put. */
export const PACKAGE_SCENE_DIFF_LOOK_GAP_MS = 2_000

/** Confidence stamped on a scene-diff sighting the model did not box. */
export const PACKAGE_SCENE_DIFF_CONFIDENCE = 0.5

export interface PackageZoneLuma {
  readonly width: number
  readonly height: number
  readonly luma: Uint8Array
}

export type PackageSceneRejectReason =
  | 'global-brightness'
  | 'zone-wide-change'
  | 'below-min-area'
  | 'overlaps-person'
  | 'overlaps-vehicle'
  | 'unstable'
  | 'crop-mismatch'

export interface PackageSceneBlob {
  readonly bbox: StationaryBbox
  readonly areaPx: number
  readonly areaFrac: number
}

export interface PackageSceneOccluder {
  readonly className: 'person' | 'vehicle'
  readonly bbox: StationaryBbox
}

export interface PackageSceneRejection {
  readonly reason: PackageSceneRejectReason
  readonly bbox?: StationaryBbox
  readonly areaFrac?: number
}

export interface PackageSceneDiffResult {
  readonly blobs: readonly PackageSceneBlob[]
  readonly rejections: readonly PackageSceneRejection[]
}

export interface PackageSceneDiffInput {
  readonly before: PackageZoneLuma
  readonly after: PackageZoneLuma
  readonly minAreaFrac: number
  readonly occluders: readonly PackageSceneOccluder[]
}

export function diffZoneLuma(input: PackageSceneDiffInput): PackageSceneDiffResult {
  const { before, after } = input
  if (
    before.width !== after.width ||
    before.height !== after.height ||
    before.luma.length !== after.luma.length
  ) {
    return { blobs: [], rejections: [{ reason: 'crop-mismatch' }] }
  }
  const median = medianDelta(before.luma, after.luma)
  const mask = residualMask(before.luma, after.luma, median)
  const zonePx = before.width * before.height
  const changed = countOnes(mask)
  if (changed / zonePx >= PACKAGE_SCENE_DIFF_MAX_CHANGED_FRAC) {
    return { blobs: [], rejections: [{ reason: 'zone-wide-change', areaFrac: changed / zonePx }] }
  }
  const judged = judgeComponents(
    connectedComponents(mask, before.width, before.height),
    zonePx,
    input.minAreaFrac,
    input.occluders,
  )
  const brightness =
    judged.blobs.length === 0 &&
    judged.rejections.length === 0 &&
    Math.abs(median) >= PACKAGE_SCENE_DIFF_LUMA_THRESHOLD
  return {
    blobs: judged.blobs,
    rejections: brightness
      ? [...judged.rejections, { reason: 'global-brightness' }]
      : judged.rejections,
  }
}

/** Mean absolute luma difference inside `bbox`. The two crops share a size. */
export function meanAbsInBox(a: PackageZoneLuma, b: PackageZoneLuma, bbox: StationaryBbox): number {
  const x0 = clampInt(bbox.x, 0, a.width)
  const y0 = clampInt(bbox.y, 0, a.height)
  const x1 = clampInt(bbox.x + bbox.w, 0, a.width)
  const y1 = clampInt(bbox.y + bbox.h, 0, a.height)
  let sum = 0
  let n = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * a.width + x
      sum += Math.abs((a.luma[i] ?? 0) - (b.luma[i] ?? 0))
      n += 1
    }
  }
  return n === 0 ? 0 : sum / n
}

function medianDelta(before: Uint8Array, after: Uint8Array): number {
  const hist = new Int32Array(511)
  for (let i = 0; i < before.length; i += 1) {
    const delta = (after[i] ?? 0) - (before[i] ?? 0)
    hist[delta + 255] = (hist[delta + 255] ?? 0) + 1
  }
  const mid = Math.floor(before.length / 2)
  let seen = 0
  for (let bin = 0; bin < hist.length; bin += 1) {
    seen += hist[bin] ?? 0
    if (seen > mid) return bin - 255
  }
  return 0
}

function residualMask(before: Uint8Array, after: Uint8Array, median: number): Uint8Array {
  const mask = new Uint8Array(before.length)
  for (let i = 0; i < before.length; i += 1) {
    const residual = Math.abs((after[i] ?? 0) - (before[i] ?? 0) - median)
    if (residual >= PACKAGE_SCENE_DIFF_LUMA_THRESHOLD) mask[i] = 1
  }
  return mask
}

function countOnes(mask: Uint8Array): number {
  let n = 0
  for (const v of mask) if (v === 1) n += 1
  return n
}

function judgeComponents(
  components: readonly Component[],
  zonePx: number,
  minAreaFrac: number,
  occluders: readonly PackageSceneOccluder[],
): PackageSceneDiffResult {
  const blobs: PackageSceneBlob[] = []
  const rejections: PackageSceneRejection[] = []
  for (const component of components) {
    const areaFrac = component.areaPx / zonePx
    if (areaFrac < minAreaFrac) {
      rejections.push({ reason: 'below-min-area', bbox: component.bbox, areaFrac })
      continue
    }
    if (areaFrac > PACKAGE_SCENE_DIFF_MAX_CHANGED_FRAC) {
      rejections.push({ reason: 'zone-wide-change', bbox: component.bbox, areaFrac })
      continue
    }
    const occluder = overlappingOccluder(component.bbox, occluders)
    if (occluder === 'person' || occluder === 'vehicle') {
      rejections.push({
        reason: occluder === 'person' ? 'overlaps-person' : 'overlaps-vehicle',
        bbox: component.bbox,
        areaFrac,
      })
      continue
    }
    blobs.push({ bbox: component.bbox, areaPx: component.areaPx, areaFrac })
  }
  return { blobs, rejections }
}

interface Component {
  readonly bbox: StationaryBbox
  readonly areaPx: number
}

function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): readonly Component[] {
  const seen = new Uint8Array(mask.length)
  const out: Component[] = []
  const stack: number[] = []
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || seen[start] === 1) continue
    stack.push(start)
    seen[start] = 1
    let area = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    while (stack.length > 0) {
      const i = stack.pop()
      if (i === undefined) break
      const x = i % width
      const y = Math.floor(i / width)
      area += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x + 1 > maxX) maxX = x + 1
      if (y + 1 > maxY) maxY = y + 1
      pushNeighbor(stack, seen, mask, width, height, x - 1, y)
      pushNeighbor(stack, seen, mask, width, height, x + 1, y)
      pushNeighbor(stack, seen, mask, width, height, x, y - 1)
      pushNeighbor(stack, seen, mask, width, height, x, y + 1)
    }
    out.push({ bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, areaPx: area })
  }
  return out
}

function pushNeighbor(
  stack: number[],
  seen: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const i = y * width + x
  if (mask[i] !== 1 || seen[i] === 1) return
  seen[i] = 1
  stack.push(i)
}

export function occlusionReason(
  blob: StationaryBbox,
  occluders: readonly PackageSceneOccluder[],
): PackageSceneRejection | null {
  const who = overlappingOccluder(blob, occluders)
  if (who === null) return null
  return { reason: who === 'person' ? 'overlaps-person' : 'overlaps-vehicle', bbox: blob }
}

function overlappingOccluder(
  blob: StationaryBbox,
  occluders: readonly PackageSceneOccluder[],
): 'person' | 'vehicle' | null {
  const blobArea = blob.w * blob.h
  if (blobArea <= 0) return null
  for (const occluder of occluders) {
    const overlap = intersectionArea(blob, occluder.bbox) / blobArea
    if (overlap >= PACKAGE_SCENE_DIFF_OCCLUDE_FRAC) return occluder.className
  }
  return null
}

function intersectionArea(a: StationaryBbox, b: StationaryBbox): number {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  if (x1 <= x0 || y1 <= y0) return 0
  return (x1 - x0) * (y1 - y0)
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}
