/**
 * Health digest (planning#572) — findings an operator can act on, built every
 * few minutes from state the orchestrator already holds in memory. A finding is
 * `{ severity, subject, what, evidence, action }`; a number that could not be
 * read is `null`, never `0` (D393).
 */
import { z } from 'zod'

export const HEALTH_FINDING_KINDS = [
  'motion-without-detections',
  'detections-under-floor',
  'inference-too-slow',
  'frames-shed',
  'inference-device-unusable',
] as const
export const HealthFindingKindSchema = z.enum(HEALTH_FINDING_KINDS)
export type HealthFindingKind = z.infer<typeof HealthFindingKindSchema>

export const HealthSeveritySchema = z.enum(['info', 'warning', 'critical'])
export type HealthSeverity = z.infer<typeof HealthSeveritySchema>

export const HealthSubjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('camera'), deviceId: z.number() }),
  z.object({ type: z.literal('node'), nodeId: z.string() }),
  z.object({ type: z.literal('inference-device'), nodeId: z.string(), deviceKey: z.string() }),
])
export type HealthSubject = z.infer<typeof HealthSubjectSchema>

export const HealthFindingSchema = z.object({
  /** Stable across ticks for the same condition on the same subject. */
  id: z.string(),
  kind: HealthFindingKindSchema,
  severity: HealthSeveritySchema,
  subject: HealthSubjectSchema,
  what: z.string(),
  /** The numbers behind the sentence; `null` = the value could not be read. */
  evidence: z.record(z.string(), z.number().nullable()),
  action: z.string(),
})
export type HealthFinding = z.infer<typeof HealthFindingSchema>

/** One in-memory source the tick read, and whether it answered. */
export const HealthSourceStatusSchema = z.object({
  source: z.string(),
  /** Entries read; `null` = the read failed. */
  entries: z.number().nullable(),
})
export type HealthSourceStatus = z.infer<typeof HealthSourceStatusSchema>

export const HealthNodeSummarySchema = z.object({
  nodeId: z.string(),
  sessionsNow: z.number(),
  /** `deviceKey` of every inference device the balancer excludes on this node. */
  unusableDevices: z.array(z.string()).readonly(),
  devices: z
    .array(z.object({ deviceKey: z.string(), sessionsNow: z.number(), usable: z.boolean() }))
    .readonly(),
})
export type HealthNodeSummary = z.infer<typeof HealthNodeSummarySchema>

/**
 * Per-camera runner-side signals, as per-tick deltas of the runner's cumulative
 * counters. A camera is listed only when at least one signal is known and
 * non-zero; `null` = the runner did not report it (unknown, never zero).
 */
export const HealthCameraRunnerSignalsSchema = z.object({
  deviceId: z.number(),
  /** Native crops the runner failed to produce since the previous tick. */
  nativeCropMissesSincePreviousTick: z.number().nullable(),
})
export type HealthCameraRunnerSignals = z.infer<typeof HealthCameraRunnerSignalsSchema>

export const HealthDigestSchema = z.object({
  generatedAt: z.number(),
  /** Wall time the tick took to build this digest. */
  tickMs: z.number(),
  /** Cameras known to the digest; `null` when a camera source failed to read (the union would be incomplete). */
  camerasSeen: z.number().nullable(),
  findings: z.array(HealthFindingSchema).readonly(),
  /** Runner-side per-camera deltas worth a look; see {@link HealthCameraRunnerSignalsSchema}. */
  cameraSignals: z.array(HealthCameraRunnerSignalsSchema).readonly(),
  nodes: z.array(HealthNodeSummarySchema).readonly(),
  sources: z.array(HealthSourceStatusSchema).readonly(),
  /** Signals the digest does not cover yet, and why — never computed by scanning. */
  notCovered: z.array(z.string()).readonly(),
})
export type HealthDigest = z.infer<typeof HealthDigestSchema>

export const HealthDigestInputSchema = z.object({
  /** Newest first; 1 = the latest digest. */
  history: z.number().int().min(1).max(24).default(1),
})
export type HealthDigestInput = z.infer<typeof HealthDigestInputSchema>

export const HealthDigestAnswerSchema = z.object({
  /** Null until the first tick has run. */
  latest: HealthDigestSchema.nullable(),
  /** Older digests, newest first, when `history` > 1. */
  previous: z.array(HealthDigestSchema).readonly(),
})
export type HealthDigestAnswer = z.infer<typeof HealthDigestAnswerSchema>
