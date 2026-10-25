/**
 * D692 §4 — has a grouped-window member anything left to wait for?
 *
 * Pure. The notification centre asks it synchronously, in-process, through the
 * `recognitionOutlook` dep pipeline-analytics wires (the recognisers and the NC share
 * the post-processing node). The answer is derived from:
 *
 *  - the camera's announced detail steps (post-analysis.md: the announce says what the
 *    camera's detail plane can run) — a class no recogniser applies to is final at once;
 *  - the face recogniser's first face instant for the track, against the TRACKER's own
 *    face-settle cap (`FACE_SETTLE_HOLD_MS`, D683 (f)), reused rather than duplicated.
 *
 * FINAL comes only from a recognition label on the member, the face cap, "no recogniser
 * applies" (and, outside this module, a track close). An identity the recogniser has
 * ASSIGNED but whose label has not reached the track is still PENDING (fresh review H-1):
 * the assignment happens a pass before the label write, and the write never comes when
 * the gallery has no name for the id.
 *
 * Anything this module cannot answer is `unknown` — PENDING (D49, D393).
 *
 * There is no settle signal for "no plate": a vehicle on a plate camera stays pending
 * until its track closes or the window's deadline. The plate recogniser's held state is
 * therefore not an input (stated in D692).
 */
import type { DetailStepAnnounce } from '@camstack/types'
import type { NcRecognitionOutlook } from '../notification-center/grouped/grouped-inputs.js'
import type { LabelKind } from './pipeline/label-tier.js'

/** The step ids whose announce means "a recogniser may name this class". */
const FACE_DETAIL_STEP_ID = 'face-detection'
const PLATE_DETAIL_STEP_ID = 'plate-detection'

export interface RecognitionOutlookInput {
  readonly className: string
  readonly labelKind?: LabelKind
  /** The camera's latest announced detail steps; undefined = never announced. */
  readonly detailSteps: readonly DetailStepAnnounce[] | undefined
  /** The face recogniser exists on this node (it may be disabled by settings). */
  readonly faceRecognizerWired: boolean
  /** First face detail instant for the track; undefined = no face seen yet. */
  readonly firstFaceAt: number | undefined
  readonly now: number
  readonly faceSettleHoldMs: number
}

/** Does an announced step with this id run on this class? Same membership test as the
 *  detail scheduler (`detail-scheduler.ts`). */
function stepApplies(
  steps: readonly DetailStepAnnounce[],
  stepId: string,
  className: string,
): boolean {
  return steps.some((s) => s.stepId === stepId && s.inputClasses.includes(className))
}

export function recognitionOutlook(input: RecognitionOutlookInput): NcRecognitionOutlook {
  if (input.labelKind === 'identity' || input.labelKind === 'plate') return { final: true }
  const steps = input.detailSteps
  if (steps === undefined) {
    return { final: false, awaiting: 'unknown', reason: 'no-detail-announce' }
  }
  const faceApplies = stepApplies(steps, FACE_DETAIL_STEP_ID, input.className)
  const plateApplies = stepApplies(steps, PLATE_DETAIL_STEP_ID, input.className)
  if (!faceApplies && !plateApplies) return { final: true }
  if (faceApplies) {
    if (!input.faceRecognizerWired) {
      return { final: false, awaiting: 'unknown', reason: 'face-recognizer-not-wired' }
    }
    if (input.firstFaceAt === undefined) return { final: false, awaiting: 'face-unseen' }
    if (input.now >= input.firstFaceAt + input.faceSettleHoldMs) return { final: true }
    return { final: false, awaiting: 'face' }
  }
  return { final: false, awaiting: 'plate' }
}
