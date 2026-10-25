import * as fs from 'node:fs'
import type { JobJournal } from './job-journal.js'
import type { StagingArea } from './staging-area.js'
import type { LifecycleJob, LifecycleTask, TaskLogEntry, TaskPhase } from '@camstack/types'

export type ApplyAddonUpdateFn = (input: {
  name: string
  version: string
  stagedPath: string
}) => Promise<void>
export type EmitFn = (kind: 'progress' | 'log', job: LifecycleJob, entry?: TaskLogEntry) => void

interface Deps {
  readonly journal: JobJournal
  readonly staging: StagingArea
  readonly applyAddonUpdate: ApplyAddonUpdateFn
  readonly emit: EmitFn
  readonly now: () => number
  readonly fetchTimeoutMs?: number
  readonly fetchConcurrency?: number
  /**
   * Predicate used by `reconcileJob` to decide whether a task's recorded
   * `stagedPath` directory still exists on disk (so apply can reuse it instead
   * of re-fetching). Defaults to `fs.existsSync`.
   */
  readonly stagedPathExists?: (p: string) => boolean
}

const DEFAULT_FETCH_TIMEOUT_MS = 60_000
const DEFAULT_FETCH_CONCURRENCY = 3

interface FetchOutcome {
  readonly task: LifecycleTask
  readonly stagedPath: string | null
}

export class LifecycleJobEngine {
  private readonly deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  private advance(
    jobId: string,
    task: LifecycleTask,
    phase: TaskPhase,
    patch: Partial<LifecycleTask> = {},
  ): LifecycleJob {
    this.deps.journal.patchTask(jobId, task.taskId, { phase, ...patch })
    const entry: TaskLogEntry = {
      tsMs: this.deps.now(),
      nodeId: task.nodeId,
      packageName: task.packageName,
      phase,
      message: `${task.packageName} → ${phase}`,
    }
    const job = this.deps.journal.appendLog(jobId, task.taskId, entry)
    this.deps.emit('progress', job)
    this.deps.emit('log', job, entry)
    return job
  }

  /**
   * Fetch + stage a single addon task (advancing it to `staged`), wrapped in a
   * per-task abort timeout. On success the resolved `stagedPath` is returned; on
   * failure the task is marked `failed` and `null` is returned (so the apply
   * phase skips it). Other tasks are unaffected.
   *
   * **`toVersion` is REWRITTEN here, to the version that was actually
   * fetched.** A task's `toVersion` starts as the REQUEST, and the request is
   * routinely a dist-tag: `addons.updatePackage` with no version resolves to
   * the literal `'latest'`. The staging area already resolves it — it reads
   * the version out of the unpacked tarball and returns `resolvedVersion` —
   * and dropping that answer sent the string `'latest'` onward as if it were a
   * version. It became the manifest's recorded version, the version the Addons
   * page displayed, and the `toVersion` on the `addon.updated` event, which an
   * operator read on his phone as "@camstack/addon-terminal 0.0.0 → latest"
   * (2026-08-30). Everything downstream of the apply reads a version; none of
   * it can resolve a tag, and none of it could tell that it had been handed
   * one.
   */
  private async fetchAddonTask(job: LifecycleJob, task: LifecycleTask): Promise<FetchOutcome> {
    try {
      this.advance(job.jobId, task, 'fetching', {
        startedAtMs: this.deps.now(),
        attempts: task.attempts + 1,
      })
      const ac = new AbortController()
      const timer = setTimeout(
        () => ac.abort(),
        this.deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      )
      let staged: { stagedPath: string; resolvedVersion: string }
      try {
        staged = await this.deps.staging.fetchAndStage({
          jobId: job.jobId,
          name: task.packageName,
          version: task.toVersion,
          signal: ac.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      const stagedPath = staged.stagedPath
      const resolved: LifecycleTask = { ...task, toVersion: staged.resolvedVersion }
      this.advance(job.jobId, task, 'staged', {
        stagedPath,
        toVersion: resolved.toVersion,
      })
      return { task: resolved, stagedPath }
    } catch (err) {
      this.advance(job.jobId, task, 'failed', {
        error: err instanceof Error ? err.message : String(err),
        finishedAtMs: this.deps.now(),
      })
      return { task, stagedPath: null }
    }
  }

  /**
   * Apply a single already-staged addon task serially:
   * `validating` → `applying` → applyAddonUpdate → `restarting` → `done`.
   * Returns true on success, false if the apply throws (task marked `failed`).
   */
  private async applyAddonTask(
    job: LifecycleJob,
    task: LifecycleTask,
    stagedPath: string,
  ): Promise<boolean> {
    try {
      this.advance(job.jobId, task, 'validating')
      this.advance(job.jobId, task, 'applying')
      await this.deps.applyAddonUpdate({
        name: task.packageName,
        version: task.toVersion,
        stagedPath,
      })
      this.advance(job.jobId, task, 'restarting')
      this.advance(job.jobId, task, 'done', { finishedAtMs: this.deps.now() })
      return true
    } catch (err) {
      this.advance(job.jobId, task, 'failed', {
        error: err instanceof Error ? err.message : String(err),
        finishedAtMs: this.deps.now(),
      })
      return false
    }
  }

  /**
   * Mark a framework task `skipped`.
   *
   * Framework packages (`@camstack/system` + its lockstep companions) are NO
   * LONGER updated through this engine. The legacy `/data/framework` per-package
   * swap was removed in the single-copy framework collapse (2026-07-18) — the
   * running framework is loaded from the active server-root single copy, and
   * framework/cap updates now ship EXCLUSIVELY via `applyServerUpdate` (the
   * node-root ServerUpdateService). Any framework task that still reaches this
   * engine (e.g. an "Update all" bulk job that swept `@camstack/system`) is
   * skipped, never applied — applying it would swap a dead dir.
   */
  private skipFrameworkTask(job: LifecycleJob, task: LifecycleTask): void {
    this.advance(job.jobId, task, 'skipped', {
      startedAtMs: task.startedAtMs ?? this.deps.now(),
      finishedAtMs: this.deps.now(),
    })
  }

  /**
   * Run the addon fetch phase with a bounded-concurrency worker pool. At most
   * `fetchConcurrency` fetches are in flight at once; completion order may vary
   * but the returned outcomes preserve the input task order.
   */
  private async fetchAddonsBounded(
    job: LifecycleJob,
    addonTasks: readonly LifecycleTask[],
  ): Promise<FetchOutcome[]> {
    const limit = Math.max(1, this.deps.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY)
    const outcomes: (FetchOutcome | undefined)[] = Array.from({ length: addonTasks.length })
    let nextIndex = 0

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex
        nextIndex += 1
        const addonTask = addonTasks[index]
        if (addonTask === undefined) return
        outcomes[index] = await this.fetchAddonTask(job, addonTask)
      }
    }

    const workerCount = Math.min(limit, addonTasks.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    // All slots are filled by the workers (every index is assigned exactly once).
    return outcomes.filter((o): o is FetchOutcome => o !== undefined)
  }

  /**
   * §10 boot reconcile: re-drive every NON-TERMINAL addon task of a job that
   * was interrupted mid-flight (e.g. a crash) from its on-disk checkpoint.
   *
   * Framework tasks are NOT applied by this engine (single-copy collapse —
   * framework updates ship via `applyServerUpdate`). Any stray non-terminal
   * framework task is marked `skipped` so the interrupted job can finalize
   * instead of hanging `running` forever. Terminal addon tasks
   * (`done`/`failed`/`skipped`) are left as-is.
   *
   * Apply is idempotent (`applyAddonUpdate` backs up the live dir + restores on
   * failure), so every non-terminal addon phase collapses to:
   *   ensure staged (reuse a still-valid `stagedPath` or re-fetch) → apply → done;
   *   on failure → `failed`.
   */
  async reconcileJob(job: LifecycleJob): Promise<LifecycleJob> {
    const exists = this.deps.stagedPathExists ?? ((p: string) => fs.existsSync(p))

    for (const task of job.tasks) {
      if (task.target === 'framework') {
        // Framework updates no longer run through this engine. Skip any stray
        // non-terminal framework task so the job can finalize.
        if (!this.isTerminal(task.phase)) this.skipFrameworkTask(job, task)
        continue
      }
      if (this.isTerminal(task.phase)) continue
      await this.reconcileAddonTask(job, task, exists)
    }

    return this.finalizeReconciledJob(job.jobId)
  }

  private isTerminal(phase: TaskPhase): boolean {
    return phase === 'done' || phase === 'failed' || phase === 'skipped'
  }

  /**
   * Re-drive a single non-terminal addon task: reuse a still-valid `stagedPath`
   * when present (idempotent re-apply), otherwise re-fetch + stage, then apply.
   */
  private async reconcileAddonTask(
    job: LifecycleJob,
    task: LifecycleTask,
    exists: (p: string) => boolean,
  ): Promise<void> {
    let stagedPath: string | null = null
    if (task.stagedPath !== null && exists(task.stagedPath)) {
      stagedPath = task.stagedPath
    } else {
      const outcome = await this.fetchAddonTask(job, task)
      stagedPath = outcome.stagedPath
    }
    // Fetch failed → task already marked `failed` by fetchAddonTask.
    if (stagedPath === null) return
    await this.applyAddonTask(job, task, stagedPath)
  }

  /**
   * Finalize a reconciled job: `completed` if all addon tasks succeeded,
   * `failed` if all failed, `partially-failed` if mixed. A skipped framework
   * task counts as neither success nor failure. Defensive: if a task is still
   * non-terminal (should not happen — reconcile drives every task terminal),
   * leave the job `running` and do not clean staging.
   */
  private finalizeReconciledJob(jobId: string): LifecycleJob {
    const current = this.deps.journal.getJob(jobId)
    if (current === null) {
      throw new Error(`LifecycleJobEngine: job '${jobId}' vanished during reconcile`)
    }

    const allTerminal = current.tasks.every((t) => this.isTerminal(t.phase))
    if (!allTerminal) {
      return current
    }

    const anyFailed = current.tasks.some((t) => t.phase === 'failed')
    const allFailed = current.tasks.every((t) => t.phase === 'failed')
    const state: LifecycleJob['state'] = !anyFailed
      ? 'completed'
      : allFailed
        ? 'failed'
        : 'partially-failed'
    const finalJob = this.deps.journal.setJobState(jobId, state)
    this.deps.staging.cleanup(jobId)
    return finalJob
  }

  async runJob(job: LifecycleJob): Promise<LifecycleJob> {
    const addonTasks = job.tasks.filter((t) => t.target !== 'framework')
    const frameworkTasks = job.tasks.filter((t) => t.target === 'framework')

    // Framework tasks are never applied by this engine (single-copy collapse —
    // framework updates ship via `applyServerUpdate`). Mark any that were swept
    // into this job `skipped`; they count as neither success nor failure.
    for (const task of frameworkTasks) {
      this.skipFrameworkTask(job, task)
    }

    let failures = 0
    let successes = 0

    // Phase FETCH (addons): bounded-concurrency fetch + stage.
    const fetchOutcomes = await this.fetchAddonsBounded(job, addonTasks)
    for (const outcome of fetchOutcomes) {
      if (outcome.stagedPath === null) failures += 1
    }

    // Phase APPLY (addons): serial, in original input order, only staged tasks.
    for (const outcome of fetchOutcomes) {
      if (outcome.stagedPath === null) continue
      const ok = await this.applyAddonTask(job, outcome.task, outcome.stagedPath)
      if (ok) successes += 1
      else failures += 1
    }

    const state: LifecycleJob['state'] =
      failures === 0 ? 'completed' : successes === 0 ? 'failed' : 'partially-failed'
    const finalJob = this.deps.journal.setJobState(job.jobId, state)
    this.deps.staging.cleanup(job.jobId)
    return finalJob
  }
}
