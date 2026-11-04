/**
 * What a running-threshold proposal says (planning#405). The schema is the
 * type: the algorithm, the capability method and the UI all read `z.infer`.
 *
 * A proposal is read-only advice: it carries the numbers it was derived from
 * (`evidence`) so the operator can judge it, and an `insufficient` answer names
 * WHY with a typed reason and the catalog defaults, never an invented number.
 */
import { z } from 'zod'
import { ThresholdTransformDraftSchema } from '../composition/customize/override-draft.js'

export const RunningProposalTierSchema = z.enum(['raw', '5m'])
export type RunningProposalTier = z.infer<typeof RunningProposalTierSchema>

export const RunningProposalConfidenceSchema = z.enum(['high', 'medium', 'low'])
export type RunningProposalConfidence = z.infer<typeof RunningProposalConfidenceSchema>

export const RunningProposalInsufficientReasonSchema = z.enum([
  /** The device has no stored series for this field. */
  'no-history',
  /** Less than a day of history: a cycle is not yet seen twice. */
  'span-too-short',
  /** The read hit the point cap — the answer would describe a part of the window. */
  'truncated',
  /** The device does not spend most of its time near one level. */
  'no-idle-floor',
  /** Nothing ran (or under ten minutes in total). */
  'no-runs',
  /** Standby noise and the running level overlap: no threshold separates them. */
  'no-separation',
])
export type RunningProposalInsufficientReason = z.infer<
  typeof RunningProposalInsufficientReasonSchema
>

export const RunningProposalReplaySchema = z.object({
  /** Intervals the real dwell expression held true over the window. */
  intervals: z.number().int().nonnegative(),
  /** Intervals outside every run, or a second interval inside one. */
  extra: z.number().int().nonnegative(),
  /** Runs without an interval of their own (none, or merged into a neighbour). */
  missed: z.number().int().nonnegative(),
})
export type RunningProposalReplay = z.infer<typeof RunningProposalReplaySchema>

export const RunningProposalEvidenceSchema = z.object({
  tier: RunningProposalTierSchema,
  spanMs: z.number().nonnegative(),
  from: z.number(),
  to: z.number(),
  points: z.number().int().nonnegative(),
  runsFound: z.number().int().nonnegative(),
  pausesFound: z.number().int().nonnegative(),
  longestPauseMs: z.number().nonnegative(),
  /** Episodes shorter than ~90 s (an anti-crease pulse, a display waking): never a run, never a pause. */
  pulsesFound: z.number().int().nonnegative(),
  longestPulseMs: z.number().nonnegative(),
  idleFloorW: z.number(),
  noiseCeilingW: z.number(),
  plateauW: z.number(),
  replay: RunningProposalReplaySchema,
})
export type RunningProposalEvidence = z.infer<typeof RunningProposalEvidenceSchema>

export const RunningProposalInsufficientEvidenceSchema = z.object({
  spanMs: z.number().nonnegative(),
  points: z.number().int().nonnegative(),
  runsFound: z.number().int().nonnegative(),
})

export const RunningThresholdProposalSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('proposal'),
    transform: ThresholdTransformDraftSchema,
    evidence: RunningProposalEvidenceSchema,
    confidence: RunningProposalConfidenceSchema,
    /** Why the confidence is not higher; empty when nothing held it back. */
    notes: z.array(z.string()),
  }),
  z.object({
    state: z.literal('insufficient'),
    reason: RunningProposalInsufficientReasonSchema,
    evidence: RunningProposalInsufficientEvidenceSchema,
    /** The catalog defaults, offered as what stands when nothing better is known. */
    fallback: ThresholdTransformDraftSchema,
  }),
])
export type RunningThresholdProposal = z.infer<typeof RunningThresholdProposalSchema>
