import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { NOT_A_DEVICE } from '../device/cap-vocabulary/system-reasons.js'
import {
  JobFailureSchema,
  JobProgressSchema,
  JobResultSchema,
  JobStateSchema,
} from './job-source.cap.js'

/**
 * `jobs` — hub singleton: the ledger of long-running work (planning#719, D1105).
 * Hosted by the alert-center builtin, with its own record kinds. Producers
 * `register` and `update` a job; the producer's `job-source` provider stays the
 * authority for what is happening now. Audience is enforced HERE, only here.
 */

/** `owner`: the owning user only. `admins`: every admin (automatic work). */
export const JobAudienceSchema = z.enum(['owner', 'admins'])
export type JobAudience = z.infer<typeof JobAudienceSchema>

/** An entity a job is about (an export, an identity…), matched exactly by kind and id. */
export const JobEntityRefSchema = z.object({ kind: z.string().min(1), id: z.string().min(1) })
export type JobEntityRef = z.infer<typeof JobEntityRefSchema>

export const JobSubjectSchema = z.object({
  deviceId: z.number().int().optional(),
  nodeId: z.string().optional(),
  entity: JobEntityRefSchema.optional(),
})
export type JobSubject = z.infer<typeof JobSubjectSchema>

export const JobTitleParamsSchema = z.record(z.string(), z.union([z.string(), z.number()]))

export const JobSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  producerAddonId: z.string(),
  /** `'system'` for automatic work. */
  ownerUserId: z.string(),
  audience: JobAudienceSchema,
  subject: JobSubjectSchema.optional(),
  titleKey: z.string(),
  titleParams: JobTitleParamsSchema,
  state: JobStateSchema,
  failure: JobFailureSchema.nullable(),
  /** `null` = unknown. */
  progress: JobProgressSchema.nullable(),
  cancellable: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The last moment the producer itself confirmed the job's state. */
  lastConfirmedAt: z.number(),
  finishedAt: z.number().nullable(),
})
export type Job = z.infer<typeof JobSchema>

export const JobRegisterInputSchema = z.object({
  kind: z.string().min(1),
  producerAddonId: z.string().min(1),
  ownerUserId: z.string().min(1),
  audience: JobAudienceSchema,
  subject: JobSubjectSchema.optional(),
  titleKey: z.string().min(1),
  titleParams: JobTitleParamsSchema.default({}),
  state: z.enum(['queued', 'running']).default('running'),
  progress: JobProgressSchema.nullable().optional(),
  cancellable: z.boolean(),
  /** The producer's own id for the job: registering twice with it returns the same `jobId`. */
  idempotencyKey: z.string().min(1),
})
export type JobRegisterInput = z.infer<typeof JobRegisterInputSchema>

export const JobUpdateInputSchema = z.object({
  jobId: z.string(),
  state: JobStateSchema.optional(),
  progress: JobProgressSchema.nullable().optional(),
  failure: JobFailureSchema.nullable().optional(),
})
export type JobUpdateInput = z.infer<typeof JobUpdateInputSchema>

export const JobCancelReasonSchema = z.enum([
  'not-found',
  'not-cancellable',
  'terminal',
  'not-allowed',
  'producer-refused',
  'producer-unreachable',
])
export type JobCancelReason = z.infer<typeof JobCancelReasonSchema>

/** `unseenFinished: null` = could not be measured (D393). */
export const JobSummarySchema = z.object({
  running: z.number(),
  unseenFinished: z.number().nullable(),
})
export type JobSummary = z.infer<typeof JobSummarySchema>

export const jobsCapability = {
  name: 'jobs',
  scope: 'system',
  mode: 'singleton',
  methods: {
    // ── Producer side (admin) ──
    register: method(JobRegisterInputSchema, z.object({ jobId: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    update: method(JobUpdateInputSchema, z.object({ updated: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    // ── Consumer side: the caller decides what is visible ──
    list: method(
      z.object({
        states: z.array(JobStateSchema).optional(),
        includeDismissed: z.boolean().default(false),
        /** Exact `subject.entity` match; still under the caller's audience. */
        entity: JobEntityRefSchema.optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      z.array(JobSchema),
      { auth: 'protected', caller: 'required', role: 'viewer' },
    ),
    get: method(z.object({ jobId: z.string() }), JobSchema.nullable(), {
      auth: 'protected',
      caller: 'required',
      role: 'viewer',
    }),
    getSummary: method(z.object({}), JobSummarySchema, {
      auth: 'protected',
      caller: 'required',
      role: 'viewer',
    }),
    /** Asks the producer to stop. The state changes only when the producer says so. */
    cancel: method(
      z.object({ jobId: z.string() }),
      z.object({ accepted: z.boolean(), reason: JobCancelReasonSchema.nullable() }),
      { kind: 'mutation', auth: 'protected', caller: 'required', role: 'viewer' },
    ),
    /** Hide a job from this user's list. Per user; never touches the job. */
    dismiss: method(z.object({ jobId: z.string() }), z.object({ dismissed: z.boolean() }), {
      kind: 'mutation',
      auth: 'protected',
      caller: 'required',
      role: 'viewer',
    }),
    /** Where the finished job's output is shown, resolved by the producer; `null` = none. */
    collect: method(z.object({ jobId: z.string() }), JobResultSchema.nullable(), {
      auth: 'protected',
      caller: 'required',
      role: 'viewer',
    }),
  },
  vocabulary: { notOperatorFacing: NOT_A_DEVICE.UI_PLUMBING },
} as const satisfies CapabilityDefinition

export type IJobsProvider = InferProvider<typeof jobsCapability>
