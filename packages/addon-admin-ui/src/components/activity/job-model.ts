/**
 * The pure side of the Activity surface (planning#719): how a job from
 * `jobs.list` becomes a label, a tone, a progress reading and the actions the
 * row may offer. No React, no i18n instance — the views translate the keys.
 *
 * A job whose progress or total is unknown is INDETERMINATE, never 0 (D393).
 */
import type { Job, JobCancelReason, JobState } from '@dominevo/types'

export type JobTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral'

export const JOB_STATES: readonly JobState[] = ['queued', 'running', 'done', 'failed', 'cancelled']

const STATE_TONE: Readonly<Record<JobState, JobTone>> = {
  queued: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
  cancelled: 'warning',
}

export function jobStateTone(state: JobState): JobTone {
  return STATE_TONE[state]
}

export function jobStateLabelKey(state: JobState): string {
  return `activity.state.${state}`
}

export function jobIsActive(job: Pick<Job, 'state'>): boolean {
  return job.state === 'queued' || job.state === 'running'
}

export type JobProgressReading =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'indeterminate'
      readonly done: number | null
      readonly unit: string | null
    }
  | {
      readonly kind: 'determinate'
      readonly done: number
      readonly total: number
      readonly unit: string
      /** 0–100, clamped. */
      readonly percent: number
    }

/**
 * `null` progress on a RUNNING job is indeterminate; a queued or finished job
 * has nothing to show. A known `done` with an unknown `total` is indeterminate too,
 * but keeps the count. A zero total is unknown, not "100%".
 */
export function readJobProgress(job: Pick<Job, 'state' | 'progress'>): JobProgressReading {
  const progress = job.progress
  if (progress === null)
    return job.state === 'running'
      ? { kind: 'indeterminate', done: null, unit: null }
      : { kind: 'none' }
  if (progress.total === null || progress.total <= 0) {
    return { kind: 'indeterminate', done: progress.done, unit: progress.unit }
  }
  const percent = Math.min(100, Math.max(0, (progress.done / progress.total) * 100))
  return {
    kind: 'determinate',
    done: progress.done,
    total: progress.total,
    unit: progress.unit,
    percent,
  }
}

export type UnitLabel = (unit: string, count: number) => string

/** "3 / 10 devices", "3 devices", or null when no count is known. `unitLabel` localises the unit. */
export function formatJobProgress(
  reading: JobProgressReading,
  unitLabel: UnitLabel = (unit) => unit,
): string | null {
  if (reading.kind === 'none') return null
  if (reading.kind === 'indeterminate') {
    if (reading.done === null) return null
    return `${String(reading.done)} ${unitLabel(reading.unit ?? '', reading.done)}`.trim()
  }
  return `${String(reading.done)} / ${String(reading.total)} ${unitLabel(reading.unit, reading.total)}`.trim()
}

export interface JobKindRef {
  readonly kind: string
}

/** i18n key of a job kind's label; the view falls back to the raw kind. */
export function jobKindLabelKey(job: JobKindRef): string {
  return `activity.kind.${job.kind.replaceAll('.', '_')}`
}

const CANCEL_REASON_KEY: Readonly<Record<JobCancelReason, string>> = {
  'not-found': 'activity.cancelRefused.notFound',
  'not-cancellable': 'activity.cancelRefused.notCancellable',
  terminal: 'activity.cancelRefused.terminal',
  'not-allowed': 'activity.cancelRefused.notAllowed',
  'producer-refused': 'activity.cancelRefused.producerRefused',
  'producer-unreachable': 'activity.cancelRefused.producerUnreachable',
}

export function cancelRefusalKey(reason: JobCancelReason | null): string {
  return reason === null ? 'activity.cancelRefused.unknown' : CANCEL_REASON_KEY[reason]
}

export function canCancelJob(job: Pick<Job, 'state' | 'cancellable'>): boolean {
  return job.cancellable && jobIsActive(job)
}

/** Only a finished job can be hidden; a live one is never dismissible. */
export function canDismissJob(job: Pick<Job, 'state'>): boolean {
  return !jobIsActive(job)
}

/** `system` is automatic work — never a user id on screen. */
export function isSystemOwned(job: Pick<Job, 'ownerUserId'>): boolean {
  return job.ownerUserId === 'system'
}

/** The badge: what is running now, plus the finished ones not yet seen. `null` = unmeasured, counted as nothing. */
export function activityBadgeCount(
  summary: { readonly running: number; readonly unseenFinished: number | null } | null | undefined,
): number {
  // An unanswered query (undefined) and a null answer both mean "nothing to count", never a crash
  if (summary === undefined || summary === null) return 0
  return summary.running + (summary.unseenFinished ?? 0)
}

/** Running first, then the newest. */
export function sortJobs<T extends Pick<Job, 'state' | 'createdAt'>>(jobs: readonly T[]): T[] {
  return [...jobs].sort((a, b) => {
    const live = Number(jobIsActive(b)) - Number(jobIsActive(a))
    return live !== 0 ? live : b.createdAt - a.createdAt
  })
}
