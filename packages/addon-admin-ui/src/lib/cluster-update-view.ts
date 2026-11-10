/**
 * How the admin UI reads the hub's cluster-update job.
 *
 * The job runs on the hub, including across the restart the hub step causes.
 * A read that fails while we are following a job is the hub restarting — the
 * same read before any job exists is an error. The steps we last saw stay on
 * screen either way.
 */
import type {
  ClusterUpdateJob,
  ClusterUpdateOptions,
  ClusterUpdateStepStatus,
} from '@camstack/types'

/** How often a followed job is read. The hub restart sits inside this gap. */
export const CLUSTER_UPDATE_POLL_MS = 3_000

export interface ClusterUpdateChoices {
  readonly skipBackup: boolean
  readonly skipAddons: boolean
}

/** Skip boxes start off: backup and addons both run unless the operator opts out. */
export function optionsFromChoices(choices: ClusterUpdateChoices): ClusterUpdateOptions {
  return {
    backup: !choices.skipBackup,
    addons: !choices.skipAddons,
  }
}

export type JobRead =
  | { readonly ok: true; readonly job: ClusterUpdateJob | null }
  | { readonly ok: false; readonly message: string }

export type ClusterUpdateView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'job'; readonly job: ClusterUpdateJob }
  | { readonly kind: 'restarting'; readonly last: ClusterUpdateJob | null }
  | { readonly kind: 'error'; readonly message: string }

/**
 * `following` is true once a job id was started or a running job was seen.
 * A failed read in that window is the hub restart, not a failed job.
 */
export function classifyJobRead(
  read: JobRead,
  following: boolean,
  last: ClusterUpdateJob | null,
): ClusterUpdateView {
  if (!read.ok) {
    return following ? { kind: 'restarting', last } : { kind: 'error', message: read.message }
  }
  // A followed job the hub cannot name yet is the same window as a dropped read:
  // the process is restarting, or the row is not visible for a moment.
  if (read.job === null) {
    return following ? { kind: 'restarting', last } : { kind: 'idle' }
  }
  return { kind: 'job', job: read.job }
}

/** Keep polling through a restart; stop when the job reaches a terminal state. */
export function nextFollowing(wasFollowing: boolean, view: ClusterUpdateView): boolean {
  if (view.kind === 'restarting') return wasFollowing
  if (view.kind === 'job') return view.job.state === 'running'
  return false
}

export type DialogMode = 'preview' | 'progress'

/** The dialog shows the job once one is running, restarting, or was just started. */
export function dialogMode(view: ClusterUpdateView, startedJobId: string | null): DialogMode {
  if (startedJobId !== null) return 'progress'
  if (view.kind === 'restarting') return 'progress'
  if (view.kind === 'job' && view.job.state === 'running') return 'progress'
  return 'preview'
}

/**
 * The strip on the page when the dialog is closed. A running job (or the last
 * snapshot while the hub restarts) is shown; a finished job is not.
 */
export function resumeJob(view: ClusterUpdateView): ClusterUpdateJob | null {
  if (view.kind === 'restarting') return view.last
  if (view.kind === 'job' && view.job.state === 'running') return view.job
  return null
}

/** StatusBadge mark for one step. `ok` is "done", not "online". */
export type StepMark = 'idle' | 'running' | 'online' | 'error' | 'disabled'

const STEP_MARK: Record<ClusterUpdateStepStatus, StepMark> = {
  pending: 'idle',
  running: 'running',
  ok: 'online',
  failed: 'error',
  skipped: 'disabled',
}

export function stepMark(status: ClusterUpdateStepStatus): StepMark {
  return STEP_MARK[status]
}
