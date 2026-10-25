/**
 * The orchestrator's durable job ledger over `ctx.records` (records plan phase 2).
 *
 * Rows are validated on the way OUT (a row a newer build wrote, or a hand
 * edit, never reaches the state machine as a half-shaped job) and dropped
 * with a log line when they do not parse — a job that cannot be read cannot
 * be reconciled, and saying so beats acting on a guess.
 */
import {
  type IScopedLogger,
  type RecordKindHandle,
  type TrainingJob,
  TrainingJobSchema,
} from '@camstack/types'
import { trainingRecordKinds } from './record-kinds.js'

/** Legacy collection name — kept for the adoption mapper / docs. */
export const TRAINING_JOBS_COLLECTION = 'training:jobs'

export interface JobStore {
  readonly put: (job: TrainingJob) => Promise<void>
  readonly get: (id: string) => Promise<TrainingJob | null>
  readonly list: () => Promise<readonly TrainingJob[]>
  readonly findByIdempotencyKey: (key: string) => Promise<TrainingJob | null>
}

export class RecordsJobStore implements JobStore {
  constructor(
    private readonly kind: RecordKindHandle<TrainingJob>,
    private readonly logger: IScopedLogger,
  ) {}

  static of(
    records: {
      kind: (def: (typeof trainingRecordKinds)['jobs']) => RecordKindHandle<TrainingJob>
    },
    logger: IScopedLogger,
  ): RecordsJobStore {
    return new RecordsJobStore(records.kind(trainingRecordKinds.jobs), logger)
  }

  readonly put = async (job: TrainingJob): Promise<void> => {
    await this.kind.put({ id: job.id, at: job.createdAt, data: job })
  }

  readonly get = async (id: string): Promise<TrainingJob | null> => {
    const row = await this.kind.get(id)
    return row === null ? null : this.parse(id, row.data)
  }

  readonly list = async (): Promise<readonly TrainingJob[]> => {
    const out: TrainingJob[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page += 1) {
      const { records, nextCursor } = await this.kind.query({
        order: 'at',
        desc: true,
        limit: 1000,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const row of records) {
        const job = this.parse(row.id, row.data)
        if (job !== null) out.push(job)
      }
      if (nextCursor === null) return out
      cursor = nextCursor
    }
    this.logger.warn('training job list hit the page bound — truncated', {
      meta: { kept: out.length },
    })
    return out
  }

  readonly findByIdempotencyKey = async (key: string): Promise<TrainingJob | null> => {
    const { records } = await this.kind.query({
      where: { idempotencyKey: key },
      limit: 1,
    })
    const row = records[0]
    return row === undefined ? null : this.parse(row.id, row.data)
  }

  private parse(id: string, data: unknown): TrainingJob | null {
    const parsed = TrainingJobSchema.safeParse(data)
    if (parsed.success) return parsed.data
    this.logger.warn('training job row does not parse — skipped', {
      meta: { jobId: id, issue: parsed.error.issues[0]?.message ?? 'unknown' },
    })
    return null
  }
}
