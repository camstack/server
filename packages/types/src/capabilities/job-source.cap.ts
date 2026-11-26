import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { NOT_A_DEVICE } from '../device/cap-vocabulary/system-reasons.js'

/**
 * `job-source` — collection cap: every addon that produces long-running jobs
 * (adoption, export, model download…) registers one provider. The hub singleton
 * `jobs` (see `jobs.cap.ts`) keeps the ledger; the producer stays the authority
 * for what is happening NOW, and for stopping it (planning#719).
 */

export const JobStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled'])
export type JobState = z.infer<typeof JobStateSchema>

/** A job in one of these states never changes again. */
export const TERMINAL_JOB_STATES: readonly JobState[] = ['done', 'failed', 'cancelled']

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state)
}

/** `interrupted` = the producer lost the job (restart) and could not say how it ended. */
export const JobFailureSchema = z.object({
  reason: z.enum(['error', 'interrupted']),
  message: z.string(),
})
export type JobFailure = z.infer<typeof JobFailureSchema>

/** `total: null` = unknown. Never `0` (D393). No stored percent. */
export const JobProgressSchema = z.object({
  done: z.number().nonnegative(),
  total: z.number().nonnegative().nullable(),
  unit: z.string(),
})
export type JobProgress = z.infer<typeof JobProgressSchema>

/** Where a finished job's output is shown; shaped like an alert action (`href` + `navigation`). */
export const JobResultSchema = z.object({
  href: z.string(),
  navigation: z.enum(['app', 'server']).optional(),
})
export type JobResult = z.infer<typeof JobResultSchema>

/** What the producer says about one job right now. */
export const JobSnapshotSchema = z.object({
  state: JobStateSchema,
  failure: JobFailureSchema.nullable(),
  progress: JobProgressSchema.nullable(),
  cancellable: z.boolean(),
  finishedAt: z.number().nullable(),
})
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>

/** `unknown: true` = the producer does not know the job (it restarted). */
export const JobSourceEntrySchema = z.union([
  z.object({ jobId: z.string(), snapshot: JobSnapshotSchema }),
  z.object({ jobId: z.string(), unknown: z.literal(true) }),
])
export type JobSourceEntry = z.infer<typeof JobSourceEntrySchema>

export const jobSourceCapability = {
  name: 'job-source',
  scope: 'system',
  mode: 'collection',
  internal: true,
  mount: { kind: 'skip' },
  methods: {
    getJobs: method(z.object({ jobIds: z.array(z.string()) }), z.array(JobSourceEntrySchema), {
      auth: 'admin',
    }),
    cancelJob: method(z.object({ jobId: z.string() }), z.object({ accepted: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    resolveResult: method(z.object({ jobId: z.string() }), JobResultSchema.nullable(), {
      auth: 'admin',
    }),
  },
  vocabulary: { notOperatorFacing: NOT_A_DEVICE.UI_PLUMBING },
} as const satisfies CapabilityDefinition

export type IJobSourceProvider = InferProvider<typeof jobSourceCapability>
