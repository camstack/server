/**
 * The initial detection is a PROPOSAL, not an answer.
 *
 * Annotating from nothing is the slowest part of the job, so the page asks the
 * pipeline what it sees in the frame and renders that as editable boxes. Every
 * proposed box arrives as `source: 'assist'` with the model and score that
 * produced it, and stays that way until the operator touches it — which is what
 * later makes a deliberate omission legible as a `model_error` rather than as a
 * frame somebody abandoned half-done.
 *
 * ## Two request shapes, one rule
 *
 * `pipelineRunner.runStatelessStep` takes a FULL frame plus a normalised
 * subject box, cuts the crop itself, and maps every detection it finds back
 * into the pixel space of the frame it was given. That mapping is why the box
 * the operator ends up editing is always in canonical full-frame coordinates,
 * whatever the assist actually ran on:
 *
 * - **whole frame** — `bbox = {0,0,1,1}`. The step's own model, the step's own
 *   thresholds.
 * - **zone crop, for packages** — `bbox = the package zone`. A package detector
 *   at 0.35 on a FULL frame proposes furniture; on the zone crop, 0.35 is the
 *   working threshold the operator agreed. The crop is the runner's job, the
 *   threshold is ours, because `runStatelessStep` carries no threshold field
 *   and a step run through it uses its catalog default.
 *
 * Nothing here does I/O. The caller supplies the runner answer; this module
 * decides what to ask for and what the answer means.
 */

import type { DetailResult, NativeCropBbox } from '@camstack/types'
import type { RetrainAnnotationDraft } from './retrain-annotation-store.js'
import { toRetrainClassTiers } from './retrain-pipeline-boxes.js'
import type { RetrainMacroClass } from './retrain-taxonomy.js'

/** The step the page asks for a proposal, and how it must be asked. */
export interface AssistPlan {
  readonly stepId: string
  readonly modelId: string
  /** What to cut before running — full frame, or the package zone. */
  readonly bbox: NativeCropBbox
  /** Proposals below this score are DROPPED before the operator sees them. */
  readonly minScore: number
  /** Parent class carried into the runner call (diagnostics + result shape). */
  readonly className: string
}

/** The whole frame, as a normalised rectangle. */
const WHOLE_FRAME: NativeCropBbox = { x: 0, y: 0, w: 1, h: 1 }

/** The package model, and the threshold it is usable at — on the ZONE only. */
export const PACKAGE_STEP_ID = 'package-detection'
export const PACKAGE_MODEL_ID = 'rfdetr-package'
export const PACKAGE_ASSIST_MIN_SCORE = 0.35

/** The general-subject detector — the default proposal for everything else. */
export const OBJECT_STEP_ID = 'object-detection'

/** What the operator asked the page to look for. */
export type AssistSubject =
  | { readonly kind: 'package'; readonly zone: NativeCropBbox | null }
  | { readonly kind: 'objects'; readonly modelId: string; readonly minScore: number }

/**
 * Build the runner request for a proposal.
 *
 * A package assist with NO zone returns `null` rather than falling back to the
 * whole frame. That fallback is the exact thing the design forbids, and a
 * silent one would look like "the model is bad at packages" for as long as
 * nobody checked which rectangle it ran on.
 */
export function planAssist(subject: AssistSubject): AssistPlan | null {
  if (subject.kind === 'package') {
    if (subject.zone === null) return null
    return {
      stepId: PACKAGE_STEP_ID,
      modelId: PACKAGE_MODEL_ID,
      bbox: subject.zone,
      minScore: PACKAGE_ASSIST_MIN_SCORE,
      className: 'package',
    }
  }
  return {
    stepId: OBJECT_STEP_ID,
    modelId: subject.modelId,
    bbox: WHOLE_FRAME,
    minScore: subject.minScore,
    className: 'object',
  }
}

/** A proposal as the page renders it, before the operator has touched it. */
export interface AssistProposal {
  readonly bbox: NativeCropBbox
  readonly macroClass: RetrainMacroClass
  readonly label?: string
  readonly score: number
  readonly modelId: string
}

/**
 * Turn the runner's details into canonical, normalised proposals.
 *
 * Three things happen, and each of them is a place a wrong box comes from:
 *
 * 1. **Threshold.** `runStatelessStep` has no threshold field, so the filter is
 *    here. Below `minScore` the box is dropped — and the count of drops goes
 *    back to the caller, because "the assist found nothing" and "the assist
 *    found six things under threshold" are different sentences.
 * 2. **Normalisation.** `DetailResult.bbox` is in the PIXEL space of the frame
 *    that was sent. An annotation is normalised `[0,1]`, always, so it survives
 *    the frame being re-encoded at another size.
 * 3. **Class.** A detector class that is not one of our macro classes is kept
 *    as the LABEL under its COCO macro (`toRetrainClassTiers`), never promoted
 *    into the macro tier. A macro class is never a label and a label is never
 *    a macro class — see `retrain-taxonomy.ts`.
 */
export interface AssistMapping {
  readonly proposals: readonly AssistProposal[]
  /** How many the runner returned but the threshold removed. */
  readonly belowThreshold: number
  /** How many carried no bbox at all — a classifier answer, not a detection. */
  readonly withoutBox: number
}

export function mapAssistDetails(input: {
  readonly details: readonly DetailResult[]
  readonly modelId: string
  readonly minScore: number
  readonly frameWidth: number
  readonly frameHeight: number
}): AssistMapping {
  const { details, modelId, minScore, frameWidth, frameHeight } = input
  if (!(frameWidth > 0) || !(frameHeight > 0)) {
    return { proposals: [], belowThreshold: 0, withoutBox: details.length }
  }
  const proposals: AssistProposal[] = []
  let belowThreshold = 0
  let withoutBox = 0
  for (const d of details) {
    if (d.bbox === undefined) {
      withoutBox += 1
      continue
    }
    if (d.score < minScore) {
      belowThreshold += 1
      continue
    }
    const bbox: NativeCropBbox = {
      x: d.bbox.x / frameWidth,
      y: d.bbox.y / frameHeight,
      w: d.bbox.w / frameWidth,
      h: d.bbox.h / frameHeight,
    }
    if (!(bbox.w > 0) || !(bbox.h > 0)) {
      withoutBox += 1
      continue
    }
    const tiers = toRetrainClassTiers(d.className, d.label)
    proposals.push({
      bbox,
      macroClass: tiers.macroClass,
      ...(tiers.label !== undefined ? { label: tiers.label } : {}),
      score: d.score,
      modelId,
    })
  }
  return { proposals, belowThreshold, withoutBox }
}

/** A proposal, as a draft annotation ready to store if the operator accepts it. */
export function proposalToDraft(
  proposal: AssistProposal,
  owner: { readonly trackId: string; readonly deviceId: number; readonly mediaKey: string },
): RetrainAnnotationDraft {
  return {
    trackId: owner.trackId,
    deviceId: owner.deviceId,
    mediaKey: owner.mediaKey,
    bbox: proposal.bbox,
    macroClass: proposal.macroClass,
    ...(proposal.label !== undefined ? { label: proposal.label } : {}),
    kind: 'subject',
    source: 'assist',
    assistModelId: proposal.modelId,
    assistScore: proposal.score,
  }
}
