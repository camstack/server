/**
 * Root child boxes (D730) — a root model's `license_plate` / `face` box made
 * into a DETAIL of the vehicle / person that contains it.
 *
 * The labels are deliberately absent from the root's classMap, so they never
 * make a first-level detection and therefore never a track (D683). When the
 * root declares a CROP supply for them, the executor keeps the boxes aside
 * instead of discarding them, and once the frame's first-level detections are
 * final this attaches each to its containing parent (`containingParentIndex`).
 * Whether the camera USES them is the runner's decision
 * (`pipeline-runner/root-supply.ts`); a box nothing contains is discarded.
 *
 * Pure.
 */
import {
  containingParentIndex,
  type CropSupplyStepId,
  type RootStepSupply,
  type SupplyBox,
} from '@camstack/types'
import type { AbsoluteBbox } from './crop-utils.js'
import type { FrameIdGenerator, MutableObjectDetection } from './result-assembler.js'

type CropSupply = Extract<RootStepSupply, { kind: 'crop' }>

/** One root box held aside for containment. */
export interface RootChildCandidate {
  readonly rawClass: string
  readonly score: number
  readonly bbox: AbsoluteBbox
  readonly supply: CropSupply
}

/** The crop supply a raw root class belongs to, if the root declares one. */
export function cropSupplyForLabel(
  supplies: readonly RootStepSupply[] | undefined,
  rawClass: string,
): CropSupply | undefined {
  for (const supply of supplies ?? []) {
    if (supply.kind === 'crop' && supply.rootLabels.includes(rawClass)) return supply
  }
  return undefined
}

function toBox(b: AbsoluteBbox): SupplyBox {
  return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }
}

/** What {@link attachRootChildBoxes} made of the candidates. */
export interface RootChildAttachment {
  readonly details: readonly MutableObjectDetection[]
  /** Boxes no parent of the right macro contains — they make nothing. */
  readonly uncontained: readonly RootChildCandidate[]
}

/**
 * Attach each candidate to the smallest first-level parent of its supply's
 * macro that contains it. Never mutates the parents.
 */
export function attachRootChildBoxes(
  candidates: readonly RootChildCandidate[],
  parents: readonly MutableObjectDetection[],
  modelId: string,
  idGen: FrameIdGenerator,
): RootChildAttachment {
  const details: MutableObjectDetection[] = []
  const uncontained: RootChildCandidate[] = []
  for (const candidate of candidates) {
    const eligible = parents.filter(
      (p) => p.kind === 'first-level' && p.macroClass === candidate.supply.parentMacro,
    )
    const index = containingParentIndex(
      toBox(candidate.bbox),
      eligible.map((p) => toBox(p.bbox)),
    )
    const parent = index >= 0 ? eligible[index] : undefined
    if (parent === undefined) {
      uncontained.push(candidate)
      continue
    }
    const stepId: CropSupplyStepId = candidate.supply.stepId
    details.push({
      id: idGen.next(),
      kind: 'detail',
      macroClass: candidate.supply.childClass,
      originalClass: candidate.rawClass,
      score: candidate.score,
      bbox: [candidate.bbox[0], candidate.bbox[1], candidate.bbox[2], candidate.bbox[3]],
      parentId: parent.id,
      rootSupplied: { stepId, modelId },
      ownLabels: [],
      alternateLabels: {},
      stepLatencyMs: {},
      modelIds: { [stepId]: modelId },
      extractMode: 'full-frame',
    })
  }
  return { details, uncontained }
}
