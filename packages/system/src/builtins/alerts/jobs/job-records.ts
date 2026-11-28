/**
 * Record kinds of the `jobs` ledger (planning#719, D1105). Owned by the alert-center
 * addon, separate from `alerts`: own kinds, no shared rows.
 */
import { defineRecordKinds, JobSchema, type DefinedRecordKind, type Job } from '@dominevo/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../../records-isolated.js'

/** One row of the ledger: a job minus its id, plus the producer's idempotency key. */
export type JobBody = Omit<Job, 'jobId'> & { readonly idempotencyKey: string }
const _jobBody: z.ZodType<JobBody> = JobSchema.omit({ jobId: true }).extend({
  idempotencyKey: z.string(),
})
export const JobBodySchema: z.ZodType<JobBody> = _jobBody

/** `jobs` row id = `<jobId>`; a dismissal row id = `<jobId>:<userId>`. */
export interface JobDismissalBody {
  readonly jobId: string
  readonly userId: string
  readonly at: number
}
const _dismissalBody: z.ZodType<JobDismissalBody> = z.object({
  jobId: z.string(),
  userId: z.string(),
  at: z.number(),
})
export const JobDismissalBodySchema: z.ZodType<JobDismissalBody> = _dismissalBody

const _jobRecordKinds = defineRecordKinds({
  jobs: {
    schema: JobBodySchema,
    class: 'ledger',
    writeTrigger:
      'jobs.register / jobs.update from a producer (a state change at once, progress at most every 5 s) and the reconcile against the producer',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'owner_state', fields: ['ownerUserId', 'state'] },
      { name: 'updated_at', fields: ['updatedAt'] },
      { name: 'idempotency', fields: ['idempotencyKey'] },
    ],
    retention: {
      owner: 'alert-center',
      reason:
        'jobsRetentionDays and jobsMaxPerOwner enforced on write; a running or queued job is never pruned',
    },
  },
  'job-dismissals': {
    schema: _dismissalBody,
    class: 'ledger',
    writeTrigger: 'jobs.dismiss by a user',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'job', fields: ['jobId'] }],
    retention: {
      owner: 'alert-center',
      reason: 'deleted together with the job it hides',
    },
  },
}) satisfies IsolatedRecordKinds

export type JobRecordKindsMap = {
  readonly jobs: DefinedRecordKind<z.ZodType<JobBody>>
  readonly 'job-dismissals': DefinedRecordKind<z.ZodType<JobDismissalBody>>
}

export const jobRecordKinds: JobRecordKindsMap = _jobRecordKinds
export const jobsRecordKind: DefinedRecordKind<z.ZodType<JobBody>> = _jobRecordKinds.jobs
export const jobDismissalsRecordKind: DefinedRecordKind<z.ZodType<JobDismissalBody>> =
  _jobRecordKinds['job-dismissals']
