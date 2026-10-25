import { useTranslation } from 'react-i18next'
/**
 * AddonsJobProgress (F4) — per-addon live progress over the lifecycle
 * job engine.
 *
 * The engine emits a FULL job snapshot on `EventCategory.AddonsJobProgress`
 * after every task-phase change. Snapshots are keyed by `jobId`, so two
 * concurrent jobs (e.g. updating two addons at once) can never overwrite
 * each other — the old bug where a single shared "updating" state was
 * clobbered by the second update.
 *
 * Layers:
 *  - `useAddonJobProgress()`   — hook: `listJobs(activeOnly)` seed (covers a
 *    page reload mid-job) merged with live per-job event snapshots, derived
 *    into a per-package progress map.
 *  - `deriveTaskProgressByPackage` — pure derivation, unit-testable.
 *  - `<AddonsJobProgress />`   — the per-addon badge rendered on the card.
 */
import { useMemo } from 'react'
import { AlertOctagon, Check, Clock, Loader2, SkipForward } from 'lucide-react'
import { EventCategory } from '@camstack/types'
import type { LifecycleJob, LifecycleJobState, TaskPhase } from '@camstack/types'
import { useAddonsListJobs, useEventStreamMap } from '@camstack/ui-library'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One package's progress, lifted from the freshest lifecycle-job task. */
export interface AddonTaskProgress {
  readonly jobId: string
  readonly packageName: string
  readonly phase: TaskPhase
  readonly fromVersion: string | null
  readonly toVersion: string
  readonly error: string | null
  readonly jobState: LifecycleJobState
  readonly finishedAtMs: number | null
}

/** Payload shape of `EventCategory.AddonsJobProgress` (see manual-boot.ts). */
interface AddonsJobProgressEventPayload {
  readonly job: LifecycleJob
}

const TERMINAL_JOB_STATES: ReadonlySet<LifecycleJobState> = new Set([
  'completed',
  'failed',
  'partially-failed',
  'cancelled',
])

const TERMINAL_TASK_PHASES: ReadonlySet<TaskPhase> = new Set(['done', 'failed', 'skipped'])

/** How long a finished task's badge stays visible before it is dropped. */
export const TERMINAL_VISIBILITY_MS = 60_000

/** True while the task is still being worked on by the engine. */
export function isTaskProgressActive(progress: AddonTaskProgress): boolean {
  return !TERMINAL_TASK_PHASES.has(progress.phase) && !TERMINAL_JOB_STATES.has(progress.jobState)
}

// ---------------------------------------------------------------------------
// Derivation (pure)
// ---------------------------------------------------------------------------

/**
 * Flatten job snapshots into a per-package progress map.
 *
 * - Jobs are visited oldest→newest so a NEWER job's task wins when the same
 *   package appears twice (retry after a failure).
 * - Entries of terminal jobs are dropped once older than
 *   `TERMINAL_VISIBILITY_MS` so "updated" badges don't linger forever.
 * - Running jobs are always visible regardless of age.
 */
export function deriveTaskProgressByPackage(
  jobs: readonly LifecycleJob[],
  nowMs: number,
): ReadonlyMap<string, AddonTaskProgress> {
  const byPackage = new Map<string, AddonTaskProgress>()
  const ordered = [...jobs].sort((a, b) => a.createdAtMs - b.createdAtMs)
  for (const job of ordered) {
    const jobTerminal = TERMINAL_JOB_STATES.has(job.state)
    for (const task of job.tasks) {
      if (
        jobTerminal &&
        task.finishedAtMs !== null &&
        nowMs - task.finishedAtMs > TERMINAL_VISIBILITY_MS
      ) {
        continue
      }
      byPackage.set(task.packageName, {
        jobId: job.jobId,
        packageName: task.packageName,
        phase: task.phase,
        fromVersion: task.fromVersion,
        toVersion: task.toVersion,
        error: task.error,
        jobState: job.state,
        finishedAtMs: task.finishedAtMs,
      })
    }
  }
  return byPackage
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Per-package lifecycle-job progress, keyed by npm package name.
 *
 * Seeded from `addons.listJobs({activeOnly:true})` (covers reload-mid-job),
 * kept live by `AddonsJobProgress` push events. Events carry the freshest
 * snapshot, so they override the seed for the same `jobId`; distinct jobs
 * accumulate side by side — completion of one never clears another.
 */
export function useAddonJobProgress(): ReadonlyMap<string, AddonTaskProgress> {
  const { data: seededJobs } = useAddonsListJobs(
    { activeOnly: true },
    {
      refetchOnWindowFocus: false,
      // Light polling only WHILE something is running — events are telemetry
      // (lossy), so the poll is the reconcile path; idle pages stop polling.
      refetchInterval: (query) => ((query.state.data?.length ?? 0) > 0 ? 3_000 : false),
    },
  )
  const { map: liveJobs } = useEventStreamMap<AddonsJobProgressEventPayload, string>(
    EventCategory.AddonsJobProgress,
    (payload) => payload.job.jobId,
  )
  return useMemo(() => {
    const byJobId = new Map<string, LifecycleJob>()
    for (const job of seededJobs ?? []) byJobId.set(job.jobId, job)
    // Event snapshots are at least as fresh as the seed query — override.
    for (const [jobId, payload] of liveJobs) byJobId.set(jobId, payload.job)
    return deriveTaskProgressByPackage([...byJobId.values()], Date.now())
  }, [seededJobs, liveJobs])
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

interface PhaseVariant {
  readonly icon: typeof Loader2
  readonly labelKey: string
  readonly cls: string
  readonly spin?: boolean
}

const PHASE_VARIANTS: Record<TaskPhase, PhaseVariant> = {
  queued: {
    icon: Clock,
    cls: 'bg-muted text-foreground-subtle',
    labelKey: 'addons.jobProgress.queued',
  },
  fetching: {
    icon: Loader2,
    cls: 'bg-primary/10 text-primary',
    labelKey: 'addons.jobProgress.fetching',
    spin: true,
  },
  staged: {
    icon: Loader2,
    cls: 'bg-primary/10 text-primary',
    labelKey: 'addons.jobProgress.staged',
    spin: true,
  },
  validating: {
    icon: Loader2,
    cls: 'bg-primary/10 text-primary',
    labelKey: 'addons.jobProgress.validating',
    spin: true,
  },
  applying: {
    icon: Loader2,
    cls: 'bg-primary/10 text-primary',
    labelKey: 'addons.jobProgress.applying',
    spin: true,
  },
  restarting: {
    icon: Loader2,
    cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    labelKey: 'addons.jobProgress.restarting',
    spin: true,
  },
  applied: {
    icon: Loader2,
    cls: 'bg-primary/10 text-primary',
    labelKey: 'addons.jobProgress.finalizing',
    spin: true,
  },
  done: { icon: Check, cls: 'bg-success/10 text-success', labelKey: 'addons.jobProgress.updated' },
  failed: {
    icon: AlertOctagon,
    cls: 'bg-danger/10 text-danger',
    labelKey: 'addons.jobProgress.failed',
  },
  skipped: {
    icon: SkipForward,
    cls: 'bg-muted text-foreground-subtle',
    labelKey: 'addons.jobProgress.skipped',
  },
}

interface AddonsJobProgressProps {
  readonly progress: AddonTaskProgress
}

/** Per-addon lifecycle-job progress badge (phase + target version). */
export function AddonsJobProgress({ progress }: AddonsJobProgressProps) {
  const { t } = useTranslation()
  const variant = PHASE_VARIANTS[progress.phase]
  const Icon = variant.icon
  const title =
    progress.error ??
    `${progress.packageName}: ${progress.fromVersion ?? '?'} → ${progress.toVersion}`
  return (
    <span
      data-testid="addon-job-progress"
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded shrink-0 ${variant.cls}`}
      title={title}
    >
      <Icon className={`w-2.5 h-2.5 ${variant.spin ? 'animate-spin' : ''}`} />
      {t(variant.labelKey)}
      <span className="font-mono">→ {progress.toVersion}</span>
    </span>
  )
}
