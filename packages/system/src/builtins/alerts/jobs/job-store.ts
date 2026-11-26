/**
 * Persistence of the jobs ledger over the `jobs` and `job-dismissals` record kinds.
 */
import type { Job, RecordKindHandle, RecordsAccess } from '@camstack/types'
import { readAllRows } from '../../../records/read-all-rows.js'
import {
  jobDismissalsRecordKind,
  jobsRecordKind,
  type JobBody,
  type JobDismissalBody,
} from './job-records.js'

/** A ledger row: the job plus the producer's idempotency key. */
export type StoredJob = Job & { readonly idempotencyKey: string }

function toStored(row: { readonly id: string; readonly data: JobBody }): StoredJob {
  return { jobId: row.id, ...row.data }
}

function toBody(job: StoredJob): JobBody {
  const { jobId: _id, ...body } = job
  return body
}

export class JobStore {
  constructor(
    private readonly jobs: RecordKindHandle<JobBody>,
    private readonly dismissals: RecordKindHandle<JobDismissalBody>,
  ) {}

  static of(records: Pick<RecordsAccess, 'kind'>): JobStore {
    return new JobStore(records.kind(jobsRecordKind), records.kind(jobDismissalsRecordKind))
  }

  async all(): Promise<readonly StoredJob[]> {
    return (await readAllRows(this.jobs)).map(toStored)
  }

  async get(jobId: string): Promise<StoredJob | null> {
    const row = await this.jobs.get(jobId)
    return row === null ? null : toStored(row)
  }

  async findByIdempotencyKey(key: string): Promise<StoredJob | null> {
    const page = await this.jobs.query({ where: { idempotencyKey: key }, limit: 1 })
    const row = page.records[0]
    return row === undefined ? null : toStored(row)
  }

  async put(job: StoredJob): Promise<void> {
    await this.jobs.put({ id: job.jobId, data: toBody(job) })
  }

  /** Deletes the jobs and every dismissal that hid them. */
  async deleteJobs(jobIds: readonly string[]): Promise<void> {
    if (jobIds.length === 0) return
    await this.jobs.deleteMany(jobIds)
    const dismissalIds: string[] = []
    for (const jobId of jobIds) {
      const rows = await readAllRows(this.dismissals, { where: { jobId } })
      dismissalIds.push(...rows.map((row) => row.id))
    }
    if (dismissalIds.length > 0) await this.dismissals.deleteMany(dismissalIds)
  }

  async dismiss(jobId: string, userId: string, at: number): Promise<void> {
    await this.dismissals.put({ id: `${jobId}:${userId}`, data: { jobId, userId, at } })
  }

  /** The ids of the jobs `userId` hid. */
  async dismissedBy(userId: string): Promise<ReadonlySet<string>> {
    const rows = await readAllRows(this.dismissals)
    return new Set(rows.filter((row) => row.data.userId === userId).map((row) => row.data.jobId))
  }
}
