/**
 * Dataset stats and annotation hash over an export manifest. Pure.
 *
 * Both read the export MANIFEST (`retrain-export.ts`), not the stores: the
 * counts a plan is judged by cannot disagree with the archive a trainer
 * receives.
 */

import { createHash } from 'node:crypto'
import type { RetrainExportManifest } from './retrain-export.js'

export type DatasetLighting = 'day' | 'night' | 'unknown'

/** Subjects of one class on one camera in one light. */
export interface DatasetCell {
  readonly macroClass: string
  readonly deviceId: number
  readonly lighting: DatasetLighting
  /** Boxes to learn (model errors excluded). */
  readonly subjects: number
  /** Frames holding at least one of them. */
  readonly frames: number
}

export interface DatasetCamera {
  readonly deviceId: number
  readonly frames: number
  readonly completeFrames: number
}

export interface DatasetStats {
  readonly frames: number
  readonly completeFrames: number
  /** `completeFrames / frames`; 0 for an empty dataset. */
  readonly completeness: number
  readonly subjects: number
  readonly modelErrors: number
  /** Complete frames with no subject — the negatives a detector needs. */
  readonly hardNegatives: number
  readonly cells: readonly DatasetCell[]
  readonly cameras: readonly DatasetCamera[]
}

function lightingOf(frame: RetrainExportManifest['frames'][number]): DatasetLighting {
  if (frame.lighting === null) return 'unknown'
  return frame.lighting.night ? 'night' : 'day'
}

/** The counts of a dataset, from the manifest an export of it would carry. */
export function datasetStats(manifest: RetrainExportManifest): DatasetStats {
  const cells = new Map<string, { cell: DatasetCell; frameIds: Set<string> }>()
  const cameras = new Map<number, { frames: number; completeFrames: number }>()
  let completeFrames = 0
  let subjects = 0
  let modelErrors = 0
  let hardNegatives = 0
  for (const frame of manifest.frames) {
    const camera = cameras.get(frame.deviceId) ?? { frames: 0, completeFrames: 0 }
    cameras.set(frame.deviceId, {
      frames: camera.frames + 1,
      completeFrames: camera.completeFrames + (frame.complete ? 1 : 0),
    })
    if (frame.complete) completeFrames += 1
    const lighting = lightingOf(frame)
    let frameSubjects = 0
    for (const a of frame.annotations) {
      if (a.kind === 'model_error') {
        modelErrors += 1
        continue
      }
      frameSubjects += 1
      const key = `${a.macroClass}|${String(frame.deviceId)}|${lighting}`
      const entry = cells.get(key) ?? {
        cell: {
          macroClass: a.macroClass,
          deviceId: frame.deviceId,
          lighting,
          subjects: 0,
          frames: 0,
        },
        frameIds: new Set<string>(),
      }
      entry.frameIds.add(frame.frameId)
      cells.set(key, {
        cell: { ...entry.cell, subjects: entry.cell.subjects + 1, frames: entry.frameIds.size },
        frameIds: entry.frameIds,
      })
    }
    subjects += frameSubjects
    if (frame.complete && frameSubjects === 0) hardNegatives += 1
  }
  const frames = manifest.frames.length
  return {
    frames,
    completeFrames,
    completeness: frames > 0 ? completeFrames / frames : 0,
    subjects,
    modelErrors,
    hardNegatives,
    cells: [...cells.values()]
      .map((e) => e.cell)
      .toSorted(
        (a, b) =>
          a.macroClass.localeCompare(b.macroClass) ||
          a.deviceId - b.deviceId ||
          a.lighting.localeCompare(b.lighting),
      ),
    cameras: [...cameras.entries()]
      .map(([deviceId, c]) => ({ deviceId, ...c }))
      .toSorted((a, b) => a.deviceId - b.deviceId),
  }
}

/** A coordinate at the precision a box is meaningful to (sub-pixel noise off). */
const q = (n: number): number => Math.round(n * 10_000) / 10_000

/** What the hash reads of one box — the manifest annotation carries it. */
export interface HashedAnnotation {
  readonly macroClass: string
  readonly label?: string
  readonly subLabel?: string
  readonly kind: string
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

/** What the hash reads of one frame — a manifest frame satisfies it. */
export interface HashedFrame {
  readonly frameId: string
  readonly complete: boolean
  readonly annotations: readonly HashedAnnotation[]
}

/**
 * The sha256 of what the frames TEACH: per frame its completeness and, per
 * box, the class tiers, the kind and the box. Row ids, timestamps, export
 * stamps and provenance are left out — they change on a re-save that teaches
 * the same thing. Order-independent.
 */
export function datasetAnnotationHash(frames: readonly HashedFrame[]): string {
  const canonical = frames
    .map((f) => ({
      f: f.frameId,
      c: f.complete,
      a: f.annotations
        .map((a) =>
          [
            a.macroClass,
            a.label ?? '',
            a.subLabel ?? '',
            a.kind,
            q(a.bbox.x),
            q(a.bbox.y),
            q(a.bbox.w),
            q(a.bbox.h),
          ].join('|'),
        )
        .toSorted(),
    }))
    .toSorted((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
