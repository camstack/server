import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  JobJournal,
  StagingArea,
  LifecycleJobEngine,
  type ApplyAddonUpdateFn,
  type EmitFn,
  type TarballFetcher,
  type ExtractFn,
} from '@camstack/system'
import type { JobKind, LifecycleJob, TaskTarget } from '@camstack/types'
import { SYSTEM_PACKAGE } from '../../core/addon/addon-package.service.js'
import { lifecycleJobsDir } from '../../lifecycle-journal-path.js'

/**
 * Deps injected when constructing a lifecycle job runner.
 * All I/O callbacks are injected for testability.
 */
export interface LifecycleJobRunnerDeps {
  /** Absolute path to the server data directory (journals + staging live here). */
  readonly dataDir: string
  /** Download the npm tarball for `name@version` as a Buffer. */
  readonly fetchTarball: TarballFetcher
  /** Extract a `.tgz` Buffer into `destDir`. */
  readonly extract: ExtractFn
  /** Atomically swap the staged dir in and restart the addon. */
  readonly applyAddonUpdate: ApplyAddonUpdateFn
  /** Forward progress/log events to the hub event bus. */
  readonly emit: EmitFn
  /** Monotonic clock — defaults to Date.now. */
  readonly now?: () => number
}

export interface StartJobTarget {
  readonly name: string
  readonly version: string
  /** Override the target type. When absent, auto-detected from the package name. */
  readonly target?: TaskTarget
}

export interface StartJobInput {
  readonly kind: JobKind
  readonly targets: ReadonlyArray<StartJobTarget>
  /** Who triggered the job (username / user-id / 'system'). */
  readonly createdBy: string
  /** Optional node id — unused for hub-local jobs, reserved for future cluster jobs. */
  readonly nodeIds?: ReadonlyArray<string>
}

export interface LifecycleJobRunner {
  startJob(input: StartJobInput): Promise<{ jobId: string }>
  getJob(jobId: string): LifecycleJob | null
  listJobs(opts?: { activeOnly?: boolean }): LifecycleJob[]
  cancelJob(jobId: string): { cancelled: boolean }
  /**
   * Re-drive every non-terminal job from its on-disk checkpoint at boot.
   * Returns a summary of how many jobs resumed to a terminal state.
   */
  reconcile(): Promise<{ resumed: number; failed: number }>
}

/**
 * Resolve a target's `TaskTarget` discriminant.
 * Explicit `target` field wins; otherwise auto-detected from package name.
 */
function resolveTaskTarget(t: StartJobTarget): TaskTarget {
  if (t.target !== undefined) return t.target
  return t.name === SYSTEM_PACKAGE ? 'framework' : 'addon'
}

/**
 * Factory that wires `JobJournal` + `StagingArea` + `LifecycleJobEngine`
 * into a thin façade that cap-providers delegates to.
 *
 * Each server boot creates a fresh instance (journals persist on disk; the
 * in-memory running-set does not).
 */
export function createLifecycleJobRunner(deps: LifecycleJobRunnerDeps): LifecycleJobRunner {
  const nowFn = deps.now ?? (() => Date.now())

  const journalDir = lifecycleJobsDir(deps.dataDir)
  const stagingDir = path.join(deps.dataDir, 'lifecycle', 'staging')

  const journal = new JobJournal(journalDir)
  const staging = new StagingArea(stagingDir, {
    fetchTarball: deps.fetchTarball,
    extract: deps.extract,
  })
  // Boot-time cleanup. The runner is recreated fresh on every server boot with
  // no jobs in flight, so any dir left under `lifecycle/staging/` is an orphan
  // from a restart that interrupted a job before its per-job cleanup() ran —
  // these otherwise accumulate forever. Sweep them once, here.
  staging.sweepOrphans()
  const engine = new LifecycleJobEngine({
    journal,
    staging,
    applyAddonUpdate: deps.applyAddonUpdate,
    emit: deps.emit,
    now: nowFn,
  })

  /**
   * Set of jobIds currently executing — used to guard cancellation.
   * We only block cancellation of running jobs (cannot abort mid-flight).
   */
  const runningJobs = new Set<string>()

  return {
    async startJob(input) {
      const jobId = randomUUID()
      const job: LifecycleJob = {
        jobId,
        kind: input.kind,
        createdAtMs: nowFn(),
        createdBy: input.createdBy,
        scope: input.targets.length === 1 ? 'single' : 'bulk',
        schemaVersion: 1,
        state: 'running',
        tasks: input.targets.map((t) => ({
          taskId: randomUUID(),
          nodeId: 'hub',
          packageName: t.name,
          fromVersion: null,
          toVersion: t.version,
          target: resolveTaskTarget(t),
          phase: 'queued' as const,
          stagedPath: null,
          attempts: 0,
          steps: [],
          error: null,
          startedAtMs: null,
          finishedAtMs: null,
        })),
      }
      journal.createJob(job)
      runningJobs.add(jobId)
      try {
        await engine.runJob(job)
      } finally {
        runningJobs.delete(jobId)
      }
      return { jobId }
    },

    getJob(jobId) {
      return journal.getJob(jobId)
    },

    listJobs(opts) {
      return journal.listJobs(opts)
    },

    cancelJob(jobId) {
      if (runningJobs.has(jobId)) {
        // Cannot cancel a job that is actively running.
        return { cancelled: false }
      }
      const job = journal.getJob(jobId)
      if (!job || job.state !== 'running') {
        return { cancelled: false }
      }
      journal.setJobState(jobId, 'cancelled')
      return { cancelled: true }
    },

    async reconcile() {
      // §10 boot reconcile: re-drive every active (non-terminal) job from its
      // on-disk checkpoint. `resumed` = jobs that progressed without ending in a
      // `failed` final state (a job left `running` because a framework task is
      // still pending its reboot resume counts as resumed — it made progress and
      // did not fail). `failed` = jobs whose final state is `failed`.
      const jobs = journal.listJobs({ activeOnly: true })
      let resumed = 0
      let failed = 0
      for (const job of jobs) {
        const result = await engine.reconcileJob(job)
        if (result.state === 'failed') {
          failed += 1
        } else {
          resumed += 1
        }
      }
      return { resumed, failed }
    },
  }
}
