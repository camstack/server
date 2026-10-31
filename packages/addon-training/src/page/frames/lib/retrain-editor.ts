/**
 * The annotation state of ONE frame on the Retrain page — pure, so the rules
 * that decide what gets saved are tested without a DOM.
 *
 * ## Drafts
 *
 * Three machines can put a box on the canvas: the live pipeline (what it drew
 * on that frame), the detector assist (the camera's model or a bigger teacher)
 * and a vision LLM. Every one of those boxes arrives as a DRAFT. A draft is
 * drawn, can be selected, accepted, corrected, relabelled, turned into a model
 * error or deleted — and until the operator does one of those it is NOT part
 * of the save. Nothing a machine proposes becomes ground truth by the
 * operator pressing Save for some other reason.
 *
 * Correcting a draft is confirming it: an operator who moved a box or changed
 * its class has looked at it. Selecting one is not.
 *
 * ## Provenance survives the confirmation
 *
 * A confirmed box keeps its `source` and the model + score that produced it.
 * That is what makes a `model_error` row readable later ("the pipeline drew
 * this at 0.61 with yolov9m-320, and it was a plant"), and what lets the
 * pipeline box the operator already decided on stay decided: a reopened frame
 * does not offer it again.
 *
 * ## Deleting is a decision, and it is remembered
 *
 * Each box that a machine proposed keeps the `origin` it was offered as. Deleting
 * such a box — saved, accepted or still a draft — records it in `dismissed`, and
 * `seedEditor` never offers a dismissed proposal again. Before this, a deleted
 * pipeline box came back as a draft on every reopen, because the only memory of
 * the decision was the absence of a saved row.
 */

import { translate } from '../../../i18n/index.js'
import type {
  RetrainAnnotation,
  RetrainAnnotationDraft,
  RetrainAnnotationSource,
  RetrainDismissed,
  RetrainMacroClass,
  RetrainOrigin,
  RetrainPipelineBox,
  RetrainVerdict,
} from '@camstack/types'
import type { NormBox } from './retrain-boxes.js'
import { applyVerdictToDraft } from './retrain-verdict-review.js'

/** What a verifier said about a box (the LLM assist's flag). */
export interface EditorFlag {
  readonly verdict: 'confirmed' | 'wrong-class' | 'not-an-object' | 'uncertain'
  readonly reason: string
  readonly suggestedClass?: RetrainMacroClass
  readonly by: string
}

/** One box on the canvas. */
export interface EditorBox {
  /** Local identity — stable across edits, never sent. */
  readonly key: string
  readonly bbox: NormBox
  readonly macroClass: RetrainMacroClass
  readonly label?: string
  readonly subLabel?: string
  readonly kind: 'subject' | 'model_error'
  readonly source: RetrainAnnotationSource
  readonly assistModelId?: string
  readonly assistScore?: number
  /** The proposal this box started from — a snapshot taken when it was offered,
   *  saved with the box so a review can tell an edit from an acceptance. */
  readonly origin?: RetrainOrigin | null
  /** A machine proposal nobody confirmed. Never saved. */
  readonly draft: boolean
  /** Why it is here — the pipeline basis, the LLM's reasoning. Never saved. */
  readonly note?: string
  readonly flag?: EditorFlag
}

/** A box before it has a key — what a proposal source hands in. */
export type EditorBoxInput = Omit<EditorBox, 'key'>

export interface EditorState {
  readonly boxes: readonly EditorBox[]
  readonly selectedKey: string | null
  /** Next local key. Monotonic, so a deleted key is never reused. */
  readonly nextKey: number
  /** Proposals the operator deleted — saved with the frame, never re-seeded. */
  readonly dismissed: readonly RetrainDismissed[]
}

/** Above this overlap a proposal is the same box as one already on screen. */
export const DUPLICATE_IOU = 0.8

/** Intersection over union of two normalised boxes. */
export function boxIou(a: NormBox, b: NormBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

function withKeys(
  state: EditorState,
  inputs: readonly EditorBoxInput[],
): { readonly boxes: EditorBox[]; readonly nextKey: number } {
  let next = state.nextKey
  const boxes = inputs.map((input): EditorBox => {
    const key = `b${String(next)}`
    next += 1
    return { ...input, key }
  })
  return { boxes, nextKey: next }
}

/** A saved annotation as an accepted box. */
function fromSaved(a: RetrainAnnotation): EditorBoxInput {
  return {
    bbox: a.bbox,
    macroClass: a.macroClass,
    ...(a.label !== undefined ? { label: a.label } : {}),
    ...(a.subLabel !== undefined ? { subLabel: a.subLabel } : {}),
    kind: a.kind,
    source: a.source,
    ...(a.assistModelId !== undefined ? { assistModelId: a.assistModelId } : {}),
    ...(a.assistScore !== undefined ? { assistScore: a.assistScore } : {}),
    origin: a.origin ?? null,
    draft: false,
  }
}

/**
 * The stable name of a pipeline box inside its frame. MUST match the server's
 * `pipelineOriginRef` (`retrain-origin.ts`): the same ref is what lets a
 * dismissal made here match the box the server re-derives tomorrow.
 */
export function pipelineOriginRef(trackId: string): string {
  return `pipeline:${trackId}`
}

/** The snapshot a pipeline box is offered with. */
export function pipelineOrigin(p: RetrainPipelineBox): RetrainOrigin {
  return {
    source: 'pipeline',
    ref: pipelineOriginRef(p.trackId),
    bbox: p.bbox,
    macroClass: p.macroClass,
    ...(p.label !== undefined ? { label: p.label } : {}),
    ...(p.score !== undefined ? { score: p.score } : {}),
    ...(p.modelId !== undefined ? { modelId: p.modelId } : {}),
  }
}

/** The pipeline's boxes on a frame, as drafts. */
export function pipelineDrafts(boxes: readonly RetrainPipelineBox[]): readonly EditorBoxInput[] {
  return boxes.map(
    (p): EditorBoxInput => ({
      origin: pipelineOrigin(p),
      bbox: p.bbox,
      macroClass: p.macroClass,
      ...(p.label !== undefined ? { label: p.label } : {}),
      ...(p.subLabel !== undefined ? { subLabel: p.subLabel } : {}),
      kind: 'subject',
      source: 'pipeline',
      ...(p.modelId !== undefined ? { assistModelId: p.modelId } : {}),
      ...(p.score !== undefined ? { assistScore: p.score } : {}),
      draft: true,
      note:
        p.basis === 'subject-box'
          ? translate('editorNote.subjectBox')
          : p.basis === 'verdict'
            ? translate('editorNote.verdictBox')
            : translate('editorNote.trackPosition', { ms: Math.round(p.deltaMs) }),
    }),
  )
}

const EMPTY: EditorState = { boxes: [], selectedKey: null, nextKey: 0, dismissed: [] }

/**
 * The state a frame opens in: what the server holds, accepted, plus the
 * pipeline's boxes as drafts — minus any the operator already decided on.
 *
 * "Decided on" is by identity (`origin.ref`), not by position: a pipeline box
 * is settled when the operator dismissed it, or kept it in any form (moved,
 * relabelled, marked a model error). A box deleted and never saved used to
 * come back here every time, because only a saved row counted as a decision.
 */
export function seedEditor(
  saved: readonly RetrainAnnotation[],
  pipeline: readonly RetrainPipelineBox[],
  dismissed: readonly RetrainDismissed[] = [],
  verdict?: RetrainVerdict,
): EditorState {
  const accepted = withKeys(EMPTY, saved.map(fromSaved))
  const keptRefs = new Set(
    saved.flatMap((a) => (a.origin !== null && a.origin !== undefined ? [a.origin.ref] : [])),
  )
  const standing = dismissed.filter((d) => !keptRefs.has(d.ref))
  const decided = new Set([...keptRefs, ...standing.map((d) => d.ref)])
  const base: EditorState = {
    boxes: accepted.boxes,
    selectedKey: null,
    nextKey: accepted.nextKey,
    dismissed: standing,
  }
  // A saved box at the same place still settles a pipeline box too — rows
  // saved before origins existed carry no ref to match on.
  const seeded = addDrafts(
    base,
    pipelineDrafts(pipeline.filter((p) => !decided.has(pipelineOriginRef(p.trackId)))),
  ).state
  if (verdict === undefined) return seeded
  // After the drafts are on screen: `addDrafts` makes everything a draft, and
  // a pre-confirmed box is exactly the one that is not.
  return {
    ...seeded,
    boxes: seeded.boxes.map((b) => ({ ...applyVerdictToDraft(b, verdict), key: b.key })),
  }
}

/** Add machine proposals as drafts, skipping duplicates of boxes on screen. */
export function addDrafts(
  state: EditorState,
  drafts: readonly EditorBoxInput[],
): { readonly state: EditorState; readonly skipped: number } {
  const kept: EditorBoxInput[] = []
  let skipped = 0
  for (const draft of drafts) {
    const onScreen = [...state.boxes, ...kept]
    if (onScreen.some((b) => boxIou(b.bbox, draft.bbox) >= DUPLICATE_IOU)) {
      skipped += 1
      continue
    }
    kept.push({ ...draft, draft: true })
  }
  const keyed = withKeys(state, kept)
  return {
    state: { ...state, boxes: [...state.boxes, ...keyed.boxes], nextKey: keyed.nextKey },
    skipped,
  }
}

/** A box the operator drew by hand — accepted from birth, and selected. */
export function addOperatorBox(
  state: EditorState,
  bbox: NormBox,
  macroClass: RetrainMacroClass,
): EditorState {
  const keyed = withKeys(state, [
    { bbox, macroClass, kind: 'subject', source: 'operator', draft: false },
  ])
  const box = keyed.boxes[0]
  if (box === undefined) return state
  const drawn: EditorBox = {
    ...box,
    origin: { source: 'operator', ref: `operator:${box.key}`, bbox, macroClass },
  }
  return {
    ...state,
    boxes: [...state.boxes, drawn],
    selectedKey: drawn.key,
    nextKey: keyed.nextKey,
  }
}

function mapBox(
  state: EditorState,
  key: string,
  change: (box: EditorBox) => EditorBox,
): EditorState {
  return { ...state, boxes: state.boxes.map((b) => (b.key === key ? change(b) : b)) }
}

/** The editable fields. Changing any of them confirms a draft. */
export type EditorBoxPatch = Partial<
  Pick<EditorBox, 'bbox' | 'macroClass' | 'label' | 'subLabel' | 'kind'>
>

export function updateBox(state: EditorState, key: string, patch: EditorBoxPatch): EditorState {
  return mapBox(state, key, (b) => ({ ...b, ...patch, draft: false }))
}

export function acceptBox(state: EditorState, key: string): EditorState {
  return mapBox(state, key, (b) => ({ ...b, draft: false }))
}

export function acceptAllDrafts(state: EditorState): EditorState {
  return { ...state, boxes: state.boxes.map((b) => (b.draft ? { ...b, draft: false } : b)) }
}

/** The phantom the operator came to remove: kept, as a deliberate omission. */
export function markModelError(state: EditorState, key: string): EditorState {
  return mapBox(state, key, (b) => ({
    ...b,
    kind: b.kind === 'model_error' ? 'subject' : 'model_error',
    draft: false,
  }))
}

/**
 * Delete a box. A box a machine proposed is remembered as dismissed — whether
 * it was a draft nobody accepted or a box already saved — so deleting it is a
 * decision that survives a reopen. A box the operator drew has no proposal
 * behind it and leaves nothing.
 */
export function deleteBox(state: EditorState, key: string): EditorState {
  const doomed = state.boxes.find((b) => b.key === key)
  const origin = doomed?.origin
  const dismissed =
    origin !== undefined && origin !== null && origin.source !== 'operator'
      ? [
          ...state.dismissed.filter((d) => d.ref !== origin.ref),
          { ref: origin.ref, snapshot: origin },
        ]
      : state.dismissed
  return {
    ...state,
    boxes: state.boxes.filter((b) => b.key !== key),
    selectedKey: state.selectedKey === key ? null : state.selectedKey,
    dismissed,
  }
}

export function selectBox(state: EditorState, key: string | null): EditorState {
  return { ...state, selectedKey: key }
}

/** Attach verifier flags to boxes by key. */
export function flagBoxes(state: EditorState, flags: ReadonlyMap<string, EditorFlag>): EditorState {
  return {
    ...state,
    boxes: state.boxes.map((b) => {
      const flag = flags.get(b.key)
      return flag !== undefined ? { ...b, flag } : b
    }),
  }
}

/** A verifier's review of a box, as the AI assist answers it. */
export interface BoxReview {
  readonly ref: string
  readonly verdict: EditorFlag['verdict']
  readonly suggestedClass?: RetrainMacroClass
  readonly reason: string
}

/** Reviews keyed by the box key they were sent under (`ref`). */
export function flagsFromReviews(
  reviews: readonly BoxReview[],
  by: string,
): ReadonlyMap<string, EditorFlag> {
  return new Map(
    reviews.map((r): [string, EditorFlag] => [
      r.ref,
      {
        verdict: r.verdict,
        reason: r.reason,
        by,
        ...(r.suggestedClass !== undefined ? { suggestedClass: r.suggestedClass } : {}),
      },
    ]),
  )
}

export function pendingDraftCount(state: EditorState): number {
  return state.boxes.filter((b) => b.draft).length
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** What `saveRetrainAnnotations` receives: the confirmed boxes, and only those. */
export function toSavePayload(state: EditorState): readonly RetrainAnnotationDraft[] {
  return state.boxes
    .filter((b) => !b.draft)
    .map((b): RetrainAnnotationDraft => {
      const label = nonEmpty(b.label)
      const subLabel = nonEmpty(b.subLabel)
      return {
        bbox: b.bbox,
        macroClass: b.macroClass,
        ...(label !== undefined ? { label } : {}),
        ...(subLabel !== undefined ? { subLabel } : {}),
        kind: b.kind,
        source: b.source,
        ...(b.assistModelId !== undefined ? { assistModelId: b.assistModelId } : {}),
        ...(b.assistScore !== undefined ? { assistScore: b.assistScore } : {}),
        ...(b.origin !== undefined ? { origin: b.origin } : {}),
      }
    })
}

/**
 * The dismissed set a save sends: every proposal the operator deleted, less any
 * the operator kept after all (the server applies the same rule).
 */
export function toSaveDismissed(state: EditorState): readonly RetrainDismissed[] {
  const kept = new Set(state.boxes.flatMap((b) => (!b.draft && b.origin ? [b.origin.ref] : [])))
  return state.dismissed.filter((d) => !kept.has(d.ref))
}
