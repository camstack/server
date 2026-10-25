/**
 * What ONE analysed frame says about the doormat — the evidence half of the
 * package stillness input, built from the executor's frame (D687, fix round 1).
 *
 * Kept out of `index.ts` so the wiring is testable through production code:
 * that the look comes from `FrameResult.packageLooked`, that an absence is
 * judged against the package step's RAW boxes (the tracker drops a parcel it
 * is still detecting — a lost track, a retracted birth), and that the
 * camera's early-pick-up switch reaches the tracker.
 */
import type { FrameResult } from '@camstack/types'
import type { StationaryBbox } from '../stationary/stationary-types.js'
import type { PackageStillnessInput } from './package-stillness-tracker.js'

/** The tracked box shape the frame processor emits. */
export interface PackageEvidenceTrack {
  readonly className: string
  readonly bbox: StationaryBbox
}

export interface PackageLookEvidenceInput {
  readonly frame: FrameResult
  readonly tracked: readonly PackageEvidenceTrack[]
  readonly packageClasses: ReadonlySet<string>
  /** `packageDropEarlyPickupEnabled` for this camera. */
  readonly earlyPickupEnabled: boolean
}

export type PackageLookEvidence = Pick<
  PackageStillnessInput,
  'looked' | 'occluders' | 'rawPackageBoxes' | 'earlyPickup'
>

export function packageLookEvidence(input: PackageLookEvidenceInput): PackageLookEvidence {
  const raw: StationaryBbox[] = []
  for (const d of input.frame.detections) {
    if (d.kind !== 'first-level' || !input.packageClasses.has(d.macroClass)) continue
    raw.push({ x: d.bbox.x, y: d.bbox.y, w: d.bbox.width, h: d.bbox.height })
  }
  // A below-threshold package box is still the step saying "something is
  // there" — never evidence of an empty doormat.
  for (const d of input.frame.discarded ?? []) {
    if (!input.packageClasses.has(d.macroClass)) continue
    const [x1, y1, x2, y2] = d.bbox
    raw.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
  }
  return {
    looked: input.frame.packageLooked === true,
    // A look at the doormat that a person or vehicle covers saw THEM.
    occluders: input.tracked
      .filter((t) => !input.packageClasses.has(t.className))
      .map((t) => ({ x: t.bbox.x, y: t.bbox.y, w: t.bbox.w, h: t.bbox.h })),
    rawPackageBoxes: raw,
    earlyPickup: input.earlyPickupEnabled,
  }
}
