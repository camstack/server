/**
 * Pure rules of the jobs ledger: who sees a job, who may stop it, what retention
 * removes. Audience is enforced here and nowhere else (planning#719, D1105).
 */
import { isTerminalJobState, type CapCaller, type Job } from '@dominevo/types'

const DAY_MS = 24 * 60 * 60 * 1000

/** Owner sees their own job; an admin also sees every `admins` job. Never another user's owner job. */
export function canSeeJob(job: Pick<Job, 'ownerUserId' | 'audience'>, caller: CapCaller): boolean {
  if (job.ownerUserId === caller.userId) return true
  return job.audience === 'admins' && caller.isAdmin
}

/** An `admins` job may be stopped by any admin, an owner job by its owner. */
export function canCancelJob(
  job: Pick<Job, 'ownerUserId' | 'audience'>,
  caller: CapCaller,
): boolean {
  if (job.audience === 'admins') return caller.isAdmin
  return job.ownerUserId === caller.userId
}

export interface JobRetention {
  readonly retentionDays: number
  readonly maxPerOwner: number
}

/**
 * The ids to delete: terminal jobs older than `retentionDays`, then, per owner, terminal jobs
 * beyond the newest `maxPerOwner`. A queued or running job is never selected.
 */
export function selectJobsToPrune(
  jobs: readonly Pick<Job, 'jobId' | 'ownerUserId' | 'state' | 'updatedAt' | 'finishedAt'>[],
  now: number,
  retention: JobRetention,
): readonly string[] {
  const cutoff = now - retention.retentionDays * DAY_MS
  const doomed = new Set<string>()
  const survivors = new Map<string, { jobId: string; updatedAt: number }[]>()
  for (const job of jobs) {
    if (!isTerminalJobState(job.state)) continue
    if ((job.finishedAt ?? job.updatedAt) < cutoff) {
      doomed.add(job.jobId)
      continue
    }
    const list = survivors.get(job.ownerUserId) ?? []
    list.push({ jobId: job.jobId, updatedAt: job.updatedAt })
    survivors.set(job.ownerUserId, list)
  }
  for (const list of survivors.values()) {
    const newestFirst = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const overflow of newestFirst.slice(retention.maxPerOwner)) doomed.add(overflow.jobId)
  }
  return [...doomed]
}
