/**
 * One camera's scene-difference episode (D931).
 *
 * The caller supplies the zone crop. This function does not fetch frames.
 * A person inside the zone freezes the "before" crop. After they leave, and
 * a settle delay, the crop is compared. A blob that is still there on the
 * next look becomes a sighting for PackageStillnessTracker.
 */

import { iou } from '../stationary/stationary-match.js'
import type { StationaryBbox } from '../stationary/stationary-types.js'
import type { PackageSighting } from './package-stillness-tracker.js'
import {
  PACKAGE_SCENE_DIFF_CONFIDENCE,
  PACKAGE_SCENE_DIFF_LOOK_GAP_MS,
  PACKAGE_SCENE_DIFF_LUMA_THRESHOLD,
  PACKAGE_SCENE_DIFF_SETTLE_MS,
  PACKAGE_SCENE_DIFF_STABLE_MEAN,
  diffZoneLuma,
  meanAbsInBox,
  occlusionReason,
  type PackageSceneBlob,
  type PackageSceneOccluder,
  type PackageSceneRejection,
  type PackageZoneLuma,
} from './package-scene-diff.js'

export interface PackageSceneCropFrame {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface PackageSceneModelBox {
  readonly bbox: StationaryBbox
  readonly score?: number
}

export type PackageScenePhase = 'clear' | 'person' | 'settling' | 'pending'

export interface PackageSceneState {
  readonly phase: PackageScenePhase
  readonly before: PackageZoneLuma | null
  readonly beforeJpeg?: Uint8Array
  readonly after: PackageZoneLuma | null
  readonly afterJpeg?: Uint8Array
  readonly leftAt: number | null
  readonly pending: readonly PackageSceneBlob[]
  readonly lastDiffAt: number
}

export interface PackageSceneStepInput {
  readonly deviceId: number
  readonly timestamp: number
  readonly detectBySceneDifference: boolean
  readonly personInZone: boolean
  readonly crop: PackageZoneLuma | null
  readonly cropJpeg?: Uint8Array
  readonly cropOrigin: { readonly x: number; readonly y: number }
  /** The crop's rectangle in the analysis frame. Absent ⇒ the crop is the frame. */
  readonly cropSizeInFrame?: { readonly w: number; readonly h: number }
  readonly frameWidth: number
  readonly frameHeight: number
  readonly minAreaFrac: number
  readonly occluders: readonly PackageSceneOccluder[]
  readonly modelBoxes: readonly PackageSceneModelBox[]
  readonly state: PackageSceneState | null
}

export interface PackageSceneStepResult {
  readonly state: PackageSceneState
  readonly sightings: readonly PackageSighting[]
  readonly rejections: readonly PackageSceneRejection[]
}

const EMPTY_STATE: PackageSceneState = {
  phase: 'clear',
  before: null,
  after: null,
  leftAt: null,
  pending: [],
  lastDiffAt: 0,
}

export function stepPackageScene(input: PackageSceneStepInput): PackageSceneStepResult {
  const prev = input.state ?? EMPTY_STATE
  if (!input.detectBySceneDifference) {
    return { state: prev, sightings: [], rejections: [] }
  }
  if (input.personInZone) return holdForPerson(prev)
  if (prev.phase === 'person') return beginSettle(prev, input.timestamp)
  if (prev.phase === 'settling') return compareAfterLeave(prev, input)
  if (prev.phase === 'pending') return confirmPending(prev, input)
  return rememberClear(prev, input)
}

function holdForPerson(prev: PackageSceneState): PackageSceneStepResult {
  return {
    state: { ...prev, phase: 'person', leftAt: null, pending: [], after: null },
    sightings: [],
    rejections: [],
  }
}

function beginSettle(prev: PackageSceneState, timestamp: number): PackageSceneStepResult {
  return {
    state: { ...prev, phase: 'settling', leftAt: timestamp, pending: [], lastDiffAt: 0 },
    sightings: [],
    rejections: [],
  }
}

function rememberClear(
  prev: PackageSceneState,
  input: PackageSceneStepInput,
): PackageSceneStepResult {
  if (!input.crop) return { state: prev, sightings: [], rejections: [] }
  return {
    state: {
      ...prev,
      phase: 'clear',
      before: input.crop,
      ...(input.cropJpeg ? { beforeJpeg: copyBytes(input.cropJpeg) } : {}),
      after: null,
      leftAt: null,
      pending: [],
    },
    sightings: [],
    rejections: [],
  }
}

function compareAfterLeave(
  prev: PackageSceneState,
  input: PackageSceneStepInput,
): PackageSceneStepResult {
  if (prev.leftAt === null || input.timestamp - prev.leftAt < PACKAGE_SCENE_DIFF_SETTLE_MS) {
    return { state: prev, sightings: [], rejections: [] }
  }
  if (prev.lastDiffAt !== 0 && input.timestamp - prev.lastDiffAt < PACKAGE_SCENE_DIFF_LOOK_GAP_MS) {
    return { state: prev, sightings: [], rejections: [] }
  }
  if (!input.crop || !prev.before) return { state: prev, sightings: [], rejections: [] }
  const diff = diffZoneLuma({
    before: prev.before,
    after: input.crop,
    minAreaFrac: input.minAreaFrac,
    occluders: input.occluders,
  })
  const blocked = diff.rejections.some(
    (r) => r.reason === 'overlaps-person' || r.reason === 'overlaps-vehicle',
  )
  if (diff.blobs.length === 0) {
    if (blocked) {
      return {
        state: { ...prev, lastDiffAt: input.timestamp },
        sightings: [],
        rejections: diff.rejections,
      }
    }
    return {
      state: {
        ...rememberClear(prev, input).state,
        lastDiffAt: input.timestamp,
      },
      sightings: [],
      rejections: diff.rejections,
    }
  }
  return {
    state: {
      ...prev,
      phase: 'pending',
      after: input.crop,
      ...(input.cropJpeg ? { afterJpeg: copyBytes(input.cropJpeg) } : {}),
      pending: diff.blobs,
      lastDiffAt: input.timestamp,
    },
    sightings: [],
    rejections: diff.rejections,
  }
}

function confirmPending(
  prev: PackageSceneState,
  input: PackageSceneStepInput,
): PackageSceneStepResult {
  if (input.timestamp - prev.lastDiffAt < PACKAGE_SCENE_DIFF_LOOK_GAP_MS) {
    return { state: prev, sightings: [], rejections: [] }
  }
  if (!input.crop || !prev.after || !prev.before) {
    return { state: prev, sightings: [], rejections: [] }
  }
  const sightings: PackageSighting[] = []
  const rejections: PackageSceneRejection[] = []
  const still: PackageSceneBlob[] = []
  for (const blob of prev.pending) {
    const judged = judgeBlob(prev, input, blob)
    if (judged.rejection) {
      rejections.push(judged.rejection)
      continue
    }
    still.push(blob)
    sightings.push(toSighting(input, blob.bbox))
  }
  if (still.length === 0) {
    return {
      state: { ...rememberClear(prev, input).state, lastDiffAt: input.timestamp },
      sightings: [],
      rejections,
    }
  }
  return {
    state: {
      ...prev,
      pending: still,
      after: input.crop,
      ...(input.cropJpeg ? { afterJpeg: copyBytes(input.cropJpeg) } : {}),
      lastDiffAt: input.timestamp,
    },
    sightings,
    rejections,
  }
}

function judgeBlob(
  prev: PackageSceneState,
  input: PackageSceneStepInput,
  blob: PackageSceneBlob,
): { readonly rejection?: PackageSceneRejection } {
  const covered = occlusionReason(blob.bbox, input.occluders)
  if (covered) return { rejection: { ...covered, areaFrac: blob.areaFrac } }
  const after = prev.after
  const before = prev.before
  const crop = input.crop
  if (!after || !before || !crop) return { rejection: { reason: 'unstable', bbox: blob.bbox } }
  const stable = meanAbsInBox(after, crop, blob.bbox) <= PACKAGE_SCENE_DIFF_STABLE_MEAN
  const present = meanAbsInBox(before, crop, blob.bbox) >= PACKAGE_SCENE_DIFF_LUMA_THRESHOLD
  if (!stable || !present)
    return { rejection: { reason: 'unstable', bbox: blob.bbox, areaFrac: blob.areaFrac } }
  return {}
}

function toSighting(input: PackageSceneStepInput, cropBox: StationaryBbox): PackageSighting {
  const crop = input.crop
  const spanW = input.cropSizeInFrame?.w ?? input.frameWidth
  const spanH = input.cropSizeInFrame?.h ?? input.frameHeight
  const scaleX = crop && crop.width > 0 ? spanW / crop.width : 1
  const scaleY = crop && crop.height > 0 ? spanH / crop.height : 1
  const bbox: StationaryBbox = {
    x: input.cropOrigin.x + cropBox.x * scaleX,
    y: input.cropOrigin.y + cropBox.y * scaleY,
    w: cropBox.w * scaleX,
    h: cropBox.h * scaleY,
  }
  let confidence = PACKAGE_SCENE_DIFF_CONFIDENCE
  for (const model of input.modelBoxes) {
    if (model.score === undefined) continue
    if (iou(bbox, model.bbox) < 0.3) continue
    if (model.score > confidence) confidence = model.score
  }
  return { className: 'package', bbox, confidence }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}
