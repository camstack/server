/**
 * Build package stillness sightings from one frame's package look — raw boxes
 * when the step looked, tracked boxes between looks.
 */

import { iou } from '../stationary/stationary-match.js'
import type { StationaryBbox } from '../stationary/stationary-types.js'
import type { PackageReferenceKind } from './package-reference-area.js'
import type { PackageSighting } from './package-stillness-tracker.js'

const TRACK_ENRICH_IOU = 0.3

export interface PackageLookRawKept {
  readonly bbox: StationaryBbox
  readonly score?: number
}

export interface PackageLookTrackedPackage {
  readonly bbox: StationaryBbox
  readonly trackId?: string
  readonly confidence?: number
  readonly keyFrameMediaId?: number
  readonly className: string
}

export interface PackageLookSightingsInput {
  readonly looked: boolean
  readonly rawKept: readonly PackageLookRawKept[]
  readonly trackedPackages: readonly PackageLookTrackedPackage[]
  readonly personBoxes: readonly StationaryBbox[]
  readonly frameWidth: number
  readonly frameHeight: number
  readonly referenceAreaPx: number
  readonly referenceKind: PackageReferenceKind
  readonly minAreaFrac: number
  readonly maxAreaFrac: number
}

export type PackageLookDropReason = 'person-overlap' | 'below-area-floor' | 'above-area-ceiling'

export interface PackageLookDrop {
  readonly reason: PackageLookDropReason
  readonly bbox: StationaryBbox
  readonly areaFrac: number
  readonly referenceKind: PackageReferenceKind
  readonly score?: number
}

export interface PackageLookSightingsResult {
  readonly sightings: readonly PackageSighting[]
  readonly drops: readonly PackageLookDrop[]
}

function boxesOverlap(a: StationaryBbox, b: StationaryBbox): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  )
}

interface PackageSightingProvenance {
  readonly trackId?: string
  readonly confidence?: number
  readonly keyFrameMediaId?: number
}

function toSighting(
  className: string,
  bbox: StationaryBbox,
  extra: PackageSightingProvenance,
): PackageSighting {
  return {
    className,
    bbox: { ...bbox },
    ...(extra.trackId !== undefined ? { trackId: extra.trackId } : {}),
    ...(extra.confidence !== undefined ? { confidence: extra.confidence } : {}),
    ...(extra.keyFrameMediaId !== undefined ? { keyFrameMediaId: extra.keyFrameMediaId } : {}),
  }
}

/** Confirmed tracks between looks: no raw open, ceiling still rejects the wedge. */
function trackedBetweenLooks(
  input: PackageLookSightingsInput,
  frameArea: number,
): PackageLookSightingsResult {
  const sightings: PackageSighting[] = []
  const drops: PackageLookDrop[] = []
  for (const t of input.trackedPackages) {
    if (frameArea > 0) {
      const maxFrac = (t.bbox.w * t.bbox.h) / frameArea
      if (maxFrac > input.maxAreaFrac) {
        drops.push({
          reason: 'above-area-ceiling',
          bbox: { ...t.bbox },
          areaFrac: maxFrac,
          referenceKind: 'frame',
          ...(t.confidence !== undefined ? { score: t.confidence } : {}),
        })
        continue
      }
    }
    sightings.push(
      toSighting(t.className, t.bbox, {
        ...(t.trackId !== undefined ? { trackId: t.trackId } : {}),
        ...(t.confidence !== undefined ? { confidence: t.confidence } : {}),
        ...(t.keyFrameMediaId !== undefined ? { keyFrameMediaId: t.keyFrameMediaId } : {}),
      }),
    )
  }
  return { sightings, drops }
}

export function packageLookSightings(input: PackageLookSightingsInput): PackageLookSightingsResult {
  const frameArea = input.frameWidth * input.frameHeight
  // Between looks the step did not run. A confirmed track can still refresh a
  // candidate, but the full-frame ceiling still applies — the streetlight
  // wedge used to open one on every coasted frame.
  if (!input.looked) {
    return trackedBetweenLooks(input, frameArea)
  }

  const minDenom = input.referenceAreaPx > 0 ? input.referenceAreaPx : frameArea > 0 ? frameArea : 0

  const drops: PackageLookDrop[] = []
  const sightings: PackageSighting[] = []
  const consumedTracked = new Set<number>()

  for (const raw of input.rawKept) {
    const bbox = raw.bbox
    if (input.personBoxes.some((p) => boxesOverlap(p, bbox))) {
      const areaFrac = minDenom > 0 ? (bbox.w * bbox.h) / minDenom : 0
      drops.push({
        reason: 'person-overlap',
        bbox: { ...bbox },
        areaFrac,
        referenceKind: input.referenceKind,
        ...(raw.score !== undefined ? { score: raw.score } : {}),
      })
      continue
    }

    const minFrac = minDenom > 0 ? (bbox.w * bbox.h) / minDenom : 0
    if (minDenom > 0 && minFrac < input.minAreaFrac) {
      drops.push({
        reason: 'below-area-floor',
        bbox: { ...bbox },
        areaFrac: minFrac,
        referenceKind: input.referenceKind,
        ...(raw.score !== undefined ? { score: raw.score } : {}),
      })
      continue
    }

    if (frameArea > 0) {
      const maxFrac = (bbox.w * bbox.h) / frameArea
      if (maxFrac > input.maxAreaFrac) {
        drops.push({
          reason: 'above-area-ceiling',
          bbox: { ...bbox },
          areaFrac: maxFrac,
          referenceKind: 'frame',
          ...(raw.score !== undefined ? { score: raw.score } : {}),
        })
        continue
      }
    }

    let bestIdx = -1
    let bestIou = 0
    for (let i = 0; i < input.trackedPackages.length; i += 1) {
      if (consumedTracked.has(i)) continue
      const tracked = input.trackedPackages[i]
      if (tracked === undefined) continue
      const match = iou(bbox, tracked.bbox)
      if (match >= TRACK_ENRICH_IOU && match > bestIou) {
        bestIou = match
        bestIdx = i
      }
    }

    if (bestIdx >= 0) {
      consumedTracked.add(bestIdx)
      const t = input.trackedPackages[bestIdx]
      if (t !== undefined) {
        const confidence = t.confidence ?? raw.score
        sightings.push(
          toSighting(t.className, bbox, {
            ...(t.trackId !== undefined ? { trackId: t.trackId } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
            ...(t.keyFrameMediaId !== undefined ? { keyFrameMediaId: t.keyFrameMediaId } : {}),
          }),
        )
      }
    } else {
      sightings.push(
        toSighting('package', bbox, {
          ...(raw.score !== undefined ? { confidence: raw.score } : {}),
        }),
      )
    }
  }

  return { sightings, drops }
}
