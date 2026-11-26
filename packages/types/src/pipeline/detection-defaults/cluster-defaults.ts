/**
 * The CLUSTER detection defaults (D1104): what a camera follows for its
 * detection stream profile and rate when the operator pinned nothing on it.
 * Resolution is camera explicit value > cluster default > code constant, and
 * `resolveDetectionDefault` is the one place that order is written.
 *
 * The plan/apply pair beside Auto tune: the plan reads and writes nothing, the
 * apply writes the cluster default only — never a camera override.
 */
import { z } from 'zod'
import { CamProfileSchema } from '../../capabilities/schemas/streaming-shared.js'
import { DetectionDefaultsRecommendationSchema } from './recommend.js'

/** The code constants a camera falls back to with no cluster default. */
export const DETECTION_STREAM_PROFILE_CONSTANT = 'high'
export const DETECTION_FPS_CONSTANT = 10

export const DETECTION_FPS_RANGE = { min: 1, max: 30 } as const

/** Stored cluster default; every field absent = follow the code constant. */
export const ClusterDetectionDefaultsSchema = z.object({
  detectionStreamProfile: CamProfileSchema.optional(),
  detectionFps: z
    .number()
    .int()
    .min(DETECTION_FPS_RANGE.min)
    .max(DETECTION_FPS_RANGE.max)
    .optional(),
})
export type ClusterDetectionDefaults = z.infer<typeof ClusterDetectionDefaultsSchema>

/** camera explicit > cluster default > code constant. */
export function resolveDetectionDefault<T>(
  explicit: T | undefined,
  cluster: T | undefined,
  constant: T,
): T {
  return explicit ?? cluster ?? constant
}

export const DetectionDefaultsPlanSchema = z.object({
  recommendation: DetectionDefaultsRecommendationSchema,
  /** The stored cluster default now (absent field = the code constant applies). */
  current: ClusterDetectionDefaultsSchema,
  /** Cameras that pin either field themselves; the apply never touches them. */
  overrides: z.object({
    count: z.number().int(),
    deviceIds: z.array(z.number().int()).readonly(),
  }),
  /** Hash of what the apply will write; the apply refuses a different one. */
  planHash: z.string(),
})
export type DetectionDefaultsPlan = z.infer<typeof DetectionDefaultsPlanSchema>

export const DetectionDefaultsApplyInputSchema = z.object({ planHash: z.string() })
export type DetectionDefaultsApplyInput = z.infer<typeof DetectionDefaultsApplyInputSchema>

export const DetectionDefaultsApplyResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('applied'), written: ClusterDetectionDefaultsSchema }),
  /** The recommendation changed since the plan was shown: confirm the fresh one. */
  z.object({ kind: z.literal('stale'), plan: DetectionDefaultsPlanSchema }),
])
export type DetectionDefaultsApplyResult = z.infer<typeof DetectionDefaultsApplyResultSchema>
