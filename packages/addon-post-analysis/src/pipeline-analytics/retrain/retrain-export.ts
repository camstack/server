/**
 * The ANNOTATED dataset export — the retrain page's own archive.
 *
 * Sibling of `training-export/`, deliberately not the same thing. That one
 * streams a marked track's stored media verbatim and knows nothing about what
 * is in it; this one streams the frames the operator SELECTED (already copied
 * into retrain storage) plus the ground truth they drew.
 *
 * ## The one interesting decision
 *
 * `annotations.json` carries, for every subject, the canonical full-frame box
 * AND the geometry derived for each model shape. **Derived here, at export,
 * never stored** — one box in, three shapes out. Storing the derived shapes is
 * how two crops of the same subject end up in one feature space, which is the
 * failure already recorded for CLIP (D52). A consumer that wants a different
 * input size or a different padding re-derives from the canonical box; nothing
 * in the database has to change and nothing can disagree.
 *
 * Everything else follows the export next door: index reads to plan, one JPEG
 * in memory at a time, a yield between files, and NO inference — a training
 * set's pixels are the pixels the pipeline saw.
 */

import {
  DEFAULT_DETAIL_CROP_CONVENTION,
  type DetailCropConvention,
  type NativeCropBbox,
  type RetrainExportFilter,
  type RetrainExportLayout,
} from '@camstack/types'
import type { Coordinates } from '../scene/condition-resolver.js'
import type { RetrainAnnotation } from './retrain-annotation-store.js'
import { workStateOf } from './retrain-corpus-query.js'
import { RECORDING_STILL_DIR, type RetrainFrame } from './retrain-frame-store.js'
import {
  type DerivedGeometry,
  deriveLetterboxRect,
  deriveSubjectCropRect,
  deriveZoneCropRect,
} from './retrain-geometry.js'
import { type RetrainFrameLighting, retrainFrameLighting } from './retrain-lighting.js'

export const RETRAIN_EXPORT_PREFIX = 'retrain-export'

/**
 * Padding a subject-crop classifier is trained with: the RUNTIME detail-crop
 * padding, read from the one convention `deriveDetailCropRect` cuts with
 * (`types/src/pipeline/detail-crop.ts`), never a second literal. It was `0.2`
 * here while the runtime fed `0.15`, so a classifier trained from this export
 * learned on more context than it is ever given live.
 */
export const CLASSIFIER_CROP_PADDING = DEFAULT_DETAIL_CROP_CONVENTION.paddingRatio

/** The convention a `crops` layout cuts with — the runtime default, recorded
 *  in the manifest so a consumer never has to assume it. */
export const RETRAIN_CROP_CONVENTION: DetailCropConvention = DEFAULT_DETAIL_CROP_CONVENTION

/** Longest side of a `crops`-layout JPEG. Classifier inputs are 224–260 px;
 *  the trainer resizes per model, so this only bounds the upload. */
export const RETRAIN_CROP_MAX_SIDE = 256

/**
 * Manifest schema id. v2 = capturedAt / complete / lighting / layout.
 * v3 = `origin` (`track` | `recording`), `epochMs` on a recording still,
 * `collectionIds`, and `trackId` ABSENT on a recording still, which has none.
 */
export const RETRAIN_MANIFEST_SCHEMA = 'camstack.retrain-export/v3'

/** Per-frame entry in the manifest. */
export interface RetrainManifestFrame {
  readonly frameId: string
  readonly path: string
  readonly deviceId: number
  /** `track`: copied from a track's media. `recording`: stilled from the
   *  recording at `epochMs` — usually a frame the model saw nothing in. */
  readonly origin: RetrainFrame['origin']
  /** Absent on a recording still. */
  readonly trackId?: string
  /** A recording still's playhead instant. */
  readonly epochMs?: number
  /** The named collections the frame belongs to (may be empty). */
  readonly collectionIds: readonly string[]
  readonly width: number
  readonly height: number
  readonly sizeBytes: number
  readonly sourceKind: string
  readonly copiedAt: number
  /** When the camera captured the frame. Absent on a pre-D785 copy. */
  readonly capturedAt?: number
  /** The operator's "every subject is boxed". Evaluate detectors on these only. */
  readonly complete: boolean
  /** Day/night (D785). `null` = unknown: no capture time and no IR proof. */
  readonly lighting: RetrainFrameLighting | null
  /**
   * The rectangle `derived.zoneCrop` was computed against, when one was known.
   *
   * Recorded rather than assumed: a consumer training a zone-cropped model has
   * to be able to see WHICH rectangle the coordinates are relative to, and a
   * derived box whose reference frame is implicit is a box nobody can check.
   */
  readonly zoneUsed?: NativeCropBbox
  readonly annotations: readonly RetrainManifestAnnotation[]
}

/** One subject, in every space a consumer might want it in. */
export interface RetrainManifestAnnotation {
  readonly id: string
  readonly macroClass: string
  readonly label?: string
  readonly subLabel?: string
  readonly kind: string
  readonly source: string
  readonly assistModelId?: string
  readonly assistScore?: number
  /** THE stored rectangle: normalised `[0,1]` against the full frame. */
  readonly bbox: NativeCropBbox
  /** `crops` layout only: the archive path of this subject's cut crop. */
  readonly cropPath?: string
  /** Derived, never stored. Absent when the box does not exist in that space. */
  readonly derived: {
    readonly letterbox?: DerivedGeometry
    readonly zoneCrop?: DerivedGeometry
    readonly subjectCrop?: DerivedGeometry
  }
}

export interface RetrainExportManifest {
  readonly schema: typeof RETRAIN_MANIFEST_SCHEMA
  readonly layout: RetrainExportLayout
  /** The convention every `subjectCrop` and every crop file was derived with. */
  readonly detailCropConvention: DetailCropConvention
  /** `crops` layout only: longest side of a crop JPEG. */
  readonly cropMaxSide?: number
  readonly generatedAt: number
  readonly batchId: string
  readonly frameCount: number
  readonly annotationCount: number
  readonly modelErrorCount: number
  readonly classifierCropPadding: number
  readonly frames: readonly RetrainManifestFrame[]
}

/** Archive path of a frame: `frames/<deviceId>/<trackId>/<frameId leaf>.jpg`,
 *  or `frames/<deviceId>/recording/<leaf>.jpg` for a recording still. */
export function retrainFramePath(frame: RetrainFrame): string {
  const leaf = frame.frameId.slice(frame.frameId.lastIndexOf(':') + 1)
  const dir = frame.origin === 'recording' ? RECORDING_STILL_DIR : frame.trackId
  return `frames/${frame.deviceId}/${dir}/${leaf}.jpg`
}

/** Archive path of a subject crop: `crops/<macroClass>/<annotationId>.jpg`. */
export function retrainCropPath(macroClass: string, annotationId: string): string {
  return `crops/${macroClass}/${annotationId}.jpg`
}

/**
 * Narrow the planned frames to a filter. Pure. Every field narrows; an empty
 * filter keeps everything. Order is the input's.
 */
export function filterRetrainExport(
  frames: readonly RetrainFrame[],
  annotationsByFrame: ReadonlyMap<string, readonly RetrainAnnotation[]>,
  filter: RetrainExportFilter,
  collectionsByFrame: ReadonlyMap<string, readonly string[]> = new Map(),
): readonly RetrainFrame[] {
  const wanted = filter.frameIds !== undefined ? new Set(filter.frameIds) : null
  const collectionIds = new Set<string>()
  if (filter.collectionIds !== undefined) {
    for (const id of filter.collectionIds) collectionIds.add(id)
  }
  if (filter.collectionId !== undefined) collectionIds.add(filter.collectionId)
  const collections = collectionIds.size > 0 ? collectionIds : null
  const devices =
    filter.deviceIds !== undefined && filter.deviceIds.length > 0 ? new Set(filter.deviceIds) : null
  const classes =
    filter.classes !== undefined && filter.classes.length > 0 ? new Set(filter.classes) : null
  return frames.filter((frame) => {
    if (wanted !== null && !wanted.has(frame.frameId)) return false
    if (devices !== null && !devices.has(frame.deviceId)) return false
    if (filter.completeOnly === true && !frame.complete) return false
    if (
      collections !== null &&
      !(collectionsByFrame.get(frame.frameId) ?? []).some((id) => collections.has(id))
    ) {
      return false
    }
    const annotations = annotationsByFrame.get(frame.frameId) ?? []
    if (filter.batchId !== undefined) {
      if (!annotations.some((a) => a.exportedInBatch === filter.batchId)) return false
    }
    if (classes !== null && !annotations.some((a) => classes.has(a.macroClass))) return false
    if (
      filter.workState !== undefined &&
      workStateOf(frame, annotations.length) !== filter.workState
    ) {
      return false
    }
    return true
  })
}

/** Whether the export filter needs every corpus copy (not only annotated/complete). */
export function exportNeedsFullCorpus(filter: RetrainExportFilter): boolean {
  if (filter.workState !== undefined) return true
  if (filter.collectionId !== undefined) return true
  if (filter.collectionIds !== undefined && filter.collectionIds.length > 0) return true
  if (filter.classes !== undefined && filter.classes.length > 0) return true
  return false
}

/**
 * Derive every per-model shape for one annotation.
 *
 * `zone` is optional and per-frame: only a package annotation has one, and a
 * `zoneCrop` for a subject the zone does not contain is ABSENT rather than
 * clamped — a clamped box teaches the model that the subject ends where the
 * crop ends.
 */
function deriveAll(
  annotation: RetrainAnnotation,
  frame: RetrainFrame,
  zone: NativeCropBbox | null,
): RetrainManifestAnnotation['derived'] {
  const letterbox = deriveLetterboxRect(annotation.bbox, frame.width, frame.height)
  const subjectCrop = deriveSubjectCropRect(annotation.bbox, CLASSIFIER_CROP_PADDING)
  const zoneCrop = zone === null ? null : deriveZoneCropRect(annotation.bbox, zone)
  return {
    ...(letterbox !== null ? { letterbox } : {}),
    ...(zoneCrop !== null ? { zoneCrop } : {}),
    ...(subjectCrop !== null ? { subjectCrop } : {}),
  }
}

export interface RetrainExportPlanInput {
  readonly frames: readonly RetrainFrame[]
  readonly annotationsByFrame: ReadonlyMap<string, readonly RetrainAnnotation[]>
  /** Package zone per device, when the camera has one. */
  readonly zoneForDevice: (deviceId: number) => NativeCropBbox | null
  readonly generatedAt: number
  readonly batchId: string
  /** Default `frames`. */
  readonly layout?: RetrainExportLayout
  /** The site's coordinates for the day/night flag; absent/null = clock. */
  readonly coordinates?: Coordinates | null
  /** frameId → the collections it belongs to. Absent = none known. */
  readonly collectionsByFrame?: ReadonlyMap<string, readonly string[]>
}

/** Build the manifest. Pure — index rows in, JSON out, no blob touched. */
export function buildRetrainManifest(input: RetrainExportPlanInput): RetrainExportManifest {
  const layout = input.layout ?? 'frames'
  const coordinates = input.coordinates ?? null
  let annotationCount = 0
  let modelErrorCount = 0
  const frames = input.frames.map((frame): RetrainManifestFrame => {
    const zone = input.zoneForDevice(frame.deviceId)
    const annotations = (input.annotationsByFrame.get(frame.frameId) ?? []).map(
      (a): RetrainManifestAnnotation => {
        annotationCount += 1
        if (a.kind === 'model_error') modelErrorCount += 1
        const derived = deriveAll(a, frame, zone)
        return {
          id: a.id,
          macroClass: a.macroClass,
          ...(a.label !== undefined ? { label: a.label } : {}),
          ...(a.subLabel !== undefined ? { subLabel: a.subLabel } : {}),
          kind: a.kind,
          source: a.source,
          ...(a.assistModelId !== undefined ? { assistModelId: a.assistModelId } : {}),
          ...(a.assistScore !== undefined ? { assistScore: a.assistScore } : {}),
          bbox: a.bbox,
          ...(layout === 'crops' && derived.subjectCrop !== undefined
            ? { cropPath: retrainCropPath(a.macroClass, a.id) }
            : {}),
          derived,
        }
      },
    )
    return {
      frameId: frame.frameId,
      path: retrainFramePath(frame),
      deviceId: frame.deviceId,
      origin: frame.origin,
      ...(frame.origin === 'track' ? { trackId: frame.trackId } : {}),
      ...(frame.epochMs !== undefined ? { epochMs: frame.epochMs } : {}),
      collectionIds: input.collectionsByFrame?.get(frame.frameId) ?? [],
      width: frame.width,
      height: frame.height,
      sizeBytes: frame.sizeBytes,
      sourceKind: frame.sourceKind,
      copiedAt: frame.copiedAt,
      ...(frame.capturedAt !== undefined ? { capturedAt: frame.capturedAt } : {}),
      complete: frame.complete,
      lighting: retrainFrameLighting({
        ...(frame.capturedAt !== undefined ? { capturedAt: frame.capturedAt } : {}),
        ...(frame.chromaSpread !== undefined ? { chromaSpread: frame.chromaSpread } : {}),
        coordinates,
      }),
      ...(zone !== null ? { zoneUsed: zone } : {}),
      annotations,
    }
  })
  return {
    schema: RETRAIN_MANIFEST_SCHEMA,
    layout,
    detailCropConvention: RETRAIN_CROP_CONVENTION,
    ...(layout === 'crops' ? { cropMaxSide: RETRAIN_CROP_MAX_SIDE } : {}),
    generatedAt: input.generatedAt,
    batchId: input.batchId,
    frameCount: frames.length,
    annotationCount,
    modelErrorCount,
    classifierCropPadding: CLASSIFIER_CROP_PADDING,
    frames,
  }
}
