/**
 * Read-modify-write of one job row, serialised per job.
 *
 * The reconcile tick, a background upload/collect task and an operator's
 * click can all touch the same job within a second. Each update re-reads the
 * row under a per-job lock and writes a NEW object (nothing is mutated in
 * place), so a slow provider call never overwrites a newer state with an old
 * snapshot.
 */
import type { TrainingJob } from '@camstack/types'
import type { JobStore } from './stores.js'

export type JobUpdate = (job: TrainingJob) => TrainingJob | null

export class JobMutator {
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly jobs: JobStore,
    private readonly now: () => number,
  ) {}

  /** Apply `fn` to the CURRENT row; `null` from `fn` = write nothing. Returns the row after. */
  async update(id: string, fn: JobUpdate): Promise<TrainingJob | null> {
    return this.locked(id, async () => {
      const job = await this.jobs.get(id)
      if (job === null) return null
      const next = fn(job)
      if (next === null) return job
      const stamped: TrainingJob = { ...next, updatedAt: this.now() }
      await this.jobs.put(stamped)
      return stamped
    })
  }

  /** Run `body` under the job's lock (for a step that must not interleave). */
  locked<T>(id: string, body: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve()
    const run = prev.then(body, body)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(id, settled)
    void settled.then(() => {
      if (this.chains.get(id) === settled) this.chains.delete(id)
    })
    return run
  }
}
