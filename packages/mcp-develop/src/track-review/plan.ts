/**
 * Verdicts in, write plan out. Pure: no hub, no clock, no randomness.
 *
 * The plan is what the reviewer shows the operator BEFORE anything is written,
 * and what `track_review_apply` executes verbatim. A verdict that needs no
 * write (correct, pipeline-bug, unsure) is listed under `skipped` with its
 * reason, so the operator sees the whole review and not only the part that
 * changes data.
 */
import { z } from 'zod'
import { RetrainAnnotationDraftSchema, RetrainMacroClassSchema } from '@camstack/types'

export const VERDICT_KINDS = [
  'correct',
  'wrong-class',
  'false-positive',
  'pipeline-bug',
  'unsure',
] as const
export const VerdictKindSchema = z.enum(VERDICT_KINDS)
export type VerdictKind = z.infer<typeof VerdictKindSchema>

/**
 * One subject that must be boxed on the frame. Either an explicit rectangle
 * (`bbox`, normalised 0..1) or the box the live pipeline drew for a track
 * (`boxOf`, resolved at apply time from the frame's pipeline boxes) with the
 * class corrected.
 */
export const SubjectSpecSchema = z
  .object({
    bbox: RetrainAnnotationDraftSchema.shape.bbox.optional(),
    boxOf: z.string().min(1).optional(),
    /** Required with `bbox`; with `boxOf` it defaults to the pipeline box's own. */
    macroClass: RetrainMacroClassSchema.optional(),
    label: z.string().min(1).optional(),
    subLabel: z.string().min(1).optional(),
    /** `model_error` marks a box the model drew where nothing is. */
    kind: RetrainAnnotationDraftSchema.shape.kind.optional(),
  })
  .refine((s) => (s.bbox !== undefined) !== (s.boxOf !== undefined), {
    message: 'give exactly one of `bbox` or `boxOf`',
  })
  .refine((s) => s.bbox === undefined || s.macroClass !== undefined, {
    message: '`macroClass` is required with an explicit `bbox`',
  })
export type SubjectSpec = z.infer<typeof SubjectSpecSchema>

export const VerdictSchema = z.object({
  trackId: z.string().min(1),
  deviceId: z.number().int(),
  verdict: VerdictKindSchema,
  /** The class the track should have had (`wrong-class`). */
  correctClass: z
    .object({
      macroClass: RetrainMacroClassSchema,
      label: z.string().optional(),
    })
    .optional(),
  /** Every subject in the frame. Defaults to the track's own box, re-classed. */
  subjects: z.array(SubjectSpecSchema).optional(),
  /** The reviewer asserts every subject in the frame is boxed. */
  complete: z.boolean().optional(),
  note: z.string().max(500).optional(),
})
export type Verdict = z.infer<typeof VerdictSchema>

export type PlanStep =
  | 'setTrackFlags'
  | 'selectRetrainFrames'
  | 'saveRetrainAnnotations'
  | 'setRetrainFrameComplete'
  | 'addRetrainFramesToCollection'

export interface PlannedTrack {
  readonly trackId: string
  readonly deviceId: number
  readonly verdict: VerdictKind
  readonly subjects: readonly SubjectSpec[]
  readonly markComplete: boolean
  readonly steps: readonly PlanStep[]
  /** The reviewer's note, kept so the plan is self-explanatory. */
  readonly note?: string
}

export interface SkippedTrack {
  readonly trackId: string
  readonly verdict: VerdictKind
  readonly reason: string
  readonly note?: string
}

export interface WritePlan {
  /** Where `track_review_apply` adds the frames when it is not given one. */
  readonly collectionName?: string
  readonly tracks: readonly PlannedTrack[]
  readonly skipped: readonly SkippedTrack[]
  readonly warnings: readonly string[]
  readonly totals: {
    readonly toWrite: number
    readonly skipped: number
    readonly complete: number
  }
}

const WRITE_STEPS: readonly PlanStep[] = [
  'setTrackFlags',
  'selectRetrainFrames',
  'saveRetrainAnnotations',
  'addRetrainFramesToCollection',
]

const NO_WRITE_REASON: Readonly<Record<'correct' | 'pipeline-bug' | 'unsure', string>> = {
  correct: 'the track is right; nothing to curate',
  'pipeline-bug': 'a pipeline defect, not a labelling error; report it, do not train on it',
  unsure: 'the reviewer could not tell; never train on a guess',
}

function defaultSubjects(v: Verdict): readonly SubjectSpec[] {
  if (v.verdict === 'false-positive') return [{ boxOf: v.trackId, kind: 'model_error' }]
  const c = v.correctClass
  if (c === undefined) return []
  return [
    {
      boxOf: v.trackId,
      macroClass: c.macroClass,
      ...(c.label !== undefined ? { label: c.label } : {}),
    },
  ]
}

function noteOf(v: Verdict): { readonly note?: string } {
  return v.note !== undefined && v.note.trim() !== '' ? { note: v.note } : {}
}

function planOne(v: Verdict, warnings: string[]): PlannedTrack | SkippedTrack {
  if (v.verdict === 'correct' || v.verdict === 'pipeline-bug' || v.verdict === 'unsure') {
    return {
      trackId: v.trackId,
      verdict: v.verdict,
      reason: NO_WRITE_REASON[v.verdict],
      ...noteOf(v),
    }
  }
  const subjects =
    v.subjects !== undefined && v.subjects.length > 0 ? v.subjects : defaultSubjects(v)
  if (subjects.length === 0) {
    return {
      trackId: v.trackId,
      verdict: v.verdict,
      reason: 'wrong-class verdict without `correctClass` or `subjects`: nothing to annotate',
      ...noteOf(v),
    }
  }
  const markComplete = v.complete === true
  if (!markComplete) {
    warnings.push(
      `${v.trackId}: not marked complete — other subjects may be unboxed, so the frame stays out of detector evaluation`,
    )
  }
  const steps: PlanStep[] = [...WRITE_STEPS]
  if (markComplete) steps.splice(3, 0, 'setRetrainFrameComplete')
  return {
    trackId: v.trackId,
    deviceId: v.deviceId,
    verdict: v.verdict,
    subjects,
    markComplete,
    steps,
    ...noteOf(v),
  }
}

function isPlanned(x: PlannedTrack | SkippedTrack): x is PlannedTrack {
  return 'steps' in x
}

export function buildPlan(verdicts: readonly Verdict[], collectionName?: string): WritePlan {
  const warnings: string[] = []
  const latest = new Map<string, Verdict>()
  for (const v of verdicts) {
    if (latest.has(v.trackId))
      warnings.push(`${v.trackId}: several verdicts given, the last one wins`)
    latest.set(v.trackId, v)
  }
  const tracks: PlannedTrack[] = []
  const skipped: SkippedTrack[] = []
  for (const v of latest.values()) {
    const planned = planOne(v, warnings)
    if (isPlanned(planned)) tracks.push(planned)
    else skipped.push(planned)
  }
  const collection = collectionName?.trim()
  return {
    ...(collection !== undefined && collection !== '' ? { collectionName: collection } : {}),
    tracks,
    skipped,
    warnings,
    totals: {
      toWrite: tracks.length,
      skipped: skipped.length,
      complete: tracks.filter((t) => t.markComplete).length,
    },
  }
}
