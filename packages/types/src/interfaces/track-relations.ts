/**
 * Ground truth for the tracking bench, as debug marks (D681, spec §4).
 *
 * Identity over live tracks, not boxes: "A and B are the same subject",
 * "A and B are different subjects", and one track's purity ("mixed" — two
 * subjects, optionally switching at an instant — or "not a subject"). Rows
 * reference tracks as PROVENANCE: they outlive the tracks by design.
 *
 * Bounded by COUNT, never by age (the D405 argument): ground truth is most
 * valuable when it is old enough for the pattern to have repeated.
 */
import { z } from 'zod'

export const MAX_TRACK_RELATIONS = 20_000
export const MAX_TRACK_PURITIES = 5_000
export const TRACK_RELATIONS_DEFAULT_LIMIT = 500

export const TrackRelationKindSchema = z.enum(['same-subject', 'different-subjects'])
export type TrackRelationKind = z.infer<typeof TrackRelationKindSchema>

export const TrackSideSchema = z.enum(['before', 'after'])
export type TrackSide = z.infer<typeof TrackSideSchema>

export const TrackPurityValueSchema = z.enum(['mixed', 'not-a-subject'])
export type TrackPurityValue = z.infer<typeof TrackPurityValueSchema>

export const TrackRelationSchema = z.object({
  id: z.string(),
  deviceId: z.number().int(),
  leftTrackId: z.string(),
  rightTrackId: z.string(),
  leftSide: TrackSideSchema.nullable(),
  rightSide: TrackSideSchema.nullable(),
  relation: TrackRelationKindSchema,
  presence: z.literal('continuous').nullable(),
  leftStartedAt: z.number().int().nullable(),
  rightStartedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  author: z.string().nullable(),
})
export type TrackRelation = z.infer<typeof TrackRelationSchema>

export const TrackPuritySchema = z.object({
  id: z.string(),
  deviceId: z.number().int(),
  sourceTrackId: z.string(),
  purity: TrackPurityValueSchema,
  switchAtMs: z.number().int().nullable(),
  startedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  author: z.string().nullable(),
})
export type TrackPurity = z.infer<typeof TrackPuritySchema>

export const SetTrackRelationInputSchema = z.object({
  deviceId: z.number().int(),
  trackId: z.string().min(1),
  otherTrackId: z.string().min(1),
  relation: TrackRelationKindSchema,
  presence: z.literal('continuous').optional(),
  trackSide: TrackSideSchema.optional(),
  otherSide: TrackSideSchema.optional(),
})
export type SetTrackRelationInput = z.infer<typeof SetTrackRelationInputSchema>

export const ClearTrackRelationInputSchema = z.object({
  deviceId: z.number().int(),
  trackId: z.string().min(1),
  otherTrackId: z.string().min(1),
})
export type ClearTrackRelationInput = z.infer<typeof ClearTrackRelationInputSchema>

export const ClearTrackRelationResultSchema = z.object({ cleared: z.boolean() })
export type ClearTrackRelationResult = z.infer<typeof ClearTrackRelationResultSchema>

export const SetTrackPurityInputSchema = z.object({
  deviceId: z.number().int(),
  trackId: z.string().min(1),
  purity: z.enum(['pure', 'mixed', 'not-a-subject']),
  switchAtMs: z.number().int().optional(),
})
export type SetTrackPurityInput = z.infer<typeof SetTrackPurityInputSchema>

/** `null` when `pure` cleared the row. */
export const SetTrackPurityResultSchema = z.object({ purity: TrackPuritySchema.nullable() })
export type SetTrackPurityResult = z.infer<typeof SetTrackPurityResultSchema>

export const ListTrackRelationsInputSchema = z.object({
  deviceId: z.number().int(),
  trackId: z.string().optional(),
  since: z.number().int().optional(),
  until: z.number().int().optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
})
export type ListTrackRelationsInput = z.infer<typeof ListTrackRelationsInputSchema>

export const ListTrackRelationsResultSchema = z.object({
  relations: z.array(TrackRelationSchema).readonly(),
  purities: z.array(TrackPuritySchema).readonly(),
  truncated: z.boolean(),
})
export type ListTrackRelationsResult = z.infer<typeof ListTrackRelationsResultSchema>

export const TrackRelationRefusalSchema = z.enum([
  'unknown-track',
  'cross-device',
  'self-relation',
  'contradiction',
  'switch-outside-track',
  'switch-needs-mixed',
])
export type TrackRelationRefusal = z.infer<typeof TrackRelationRefusalSchema>
