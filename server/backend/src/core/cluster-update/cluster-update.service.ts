/**
 * ClusterUpdateService — the ONE cluster update flow (planning#493): backup,
 * the hub's server closure, every online agent (verified: target, settled,
 * online, capabilities registered), then the addons. The admin UI, the MCP
 * and the CLI start this job and read its report; none of them drives a loop
 * of its own any more.
 *
 * The hub updates ITSELF in the middle of the job, so the job is durable: each
 * step is persisted before it runs, and the new boot `resume()`s it. A hub
 * step that was running is verified against the version the hub now runs; any
 * OTHER step found running on a fresh boot was cut by an unplanned restart and
 * is reported `interrupted` — never resumed blind, never left "running".
 *
 * State is read by RPC (`getJob`); nothing about it travels on events (D8).
 */
import type {
  ClusterUpdateFailureReason,
  ClusterUpdateJob,
  ClusterUpdateOptions,
  ClusterUpdatePlan,
  ClusterUpdateStep,
  StartClusterUpdateResult,
} from '@camstack/types'
import { readClusterUpdatePlan } from './cluster-update-plan.js'
import { errText, type ClusterUpdateSeams } from './cluster-update-seams.js'
import {
  runAddonsStep,
  runBackupStep,
  runServerStep,
  verifyServerStep,
  type StepOutcome,
} from './cluster-update-steps.js'

function isOpen(step: ClusterUpdateStep): boolean {
  return step.status === 'pending' || step.status === 'running'
}

export class ClusterUpdateService {
  private running: Promise<void> | null = null
  private resumed = false

  constructor(private readonly seams: ClusterUpdateSeams) {}

  /** What a start would do now. */
  async preview(options: ClusterUpdateOptions): Promise<ClusterUpdatePlan> {
    this.resume()
    const plan = await readClusterUpdatePlan(this.seams, options)
    const active = this.activeJob()
    if (active !== null) {
      return {
        ...plan,
        blocker: 'job-running',
        blockerDetail: `cluster update ${active.id} is running (target ${active.targetVersion})`,
      }
    }
    return plan
  }

  /** Start the job; returns at once. One job at a time. */
  async start(
    options: ClusterUpdateOptions,
    requestedBy: string,
  ): Promise<StartClusterUpdateResult> {
    this.resume()
    const active = this.activeJob()
    if (active !== null) {
      return {
        accepted: false,
        jobId: active.id,
        blocker: 'job-running',
        message: `cluster update ${active.id} is already running`,
      }
    }
    const plan = await readClusterUpdatePlan(this.seams, options)
    if (plan.blocker !== null || plan.targetVersion === null) {
      return {
        accepted: false,
        jobId: null,
        blocker: plan.blocker ?? 'no-target',
        message: plan.blockerDetail ?? 'no target version',
      }
    }
    const job: ClusterUpdateJob = {
      id: this.seams.newId(),
      state: 'running',
      targetVersion: plan.targetVersion,
      requestedBy,
      startedAt: this.seams.now(),
      steps: plan.steps,
      skippedOffline: plan.skippedOffline,
    }
    this.seams.store.save(job)
    this.seams.logger.info('Cluster update started', {
      meta: {
        jobId: job.id,
        target: job.targetVersion,
        steps: job.steps.length,
        requestedBy,
      },
    })
    this.launch(job, 0)
    return {
      accepted: true,
      jobId: job.id,
      blocker: null,
      message: `cluster update ${job.id} started, target ${job.targetVersion}`,
    }
  }

  /** The job (the latest without `jobId`), or `null`. */
  getJob(jobId?: string): ClusterUpdateJob | null {
    this.resume()
    const job = this.seams.store.load()
    if (job === null) return null
    return jobId === undefined || job.id === jobId ? job : null
  }

  /**
   * Pick up a job the previous boot left running. Idempotent and cheap: boot
   * calls it once the addons are up, and every RPC calls it too, so a dropped
   * boot event still resumes on the next read (D49).
   */
  resume(): void {
    if (this.resumed) return
    this.resumed = true
    const job = this.seams.store.load()
    if (job === null || job.state !== 'running' || this.running !== null) return
    const index = job.steps.findIndex(isOpen)
    const step = index >= 0 ? job.steps[index] : undefined
    if (step === undefined) {
      this.finish({ ...job }, null)
      return
    }
    if (step.kind === 'hub-server' && step.status === 'running') {
      this.seams.logger.info('Cluster update resumed after the hub restart', {
        meta: { jobId: job.id, target: job.targetVersion },
      })
      this.launch(job, index, true)
      return
    }
    this.stop(job, index, {
      status: 'failed',
      reason: 'interrupted',
      detail: `the hub restarted while this step was ${step.status}; nothing resumes a step blind`,
    })
  }

  /** Resolves when the job this process runs has ended (tests, shutdown). */
  async idle(): Promise<void> {
    await this.running
  }

  private activeJob(): ClusterUpdateJob | null {
    const job = this.seams.store.load()
    return job !== null && job.state === 'running' ? job : null
  }

  private launch(job: ClusterUpdateJob, from: number, resumingHub = false): void {
    this.running = this.execute(job, from, resumingHub)
      .catch((err: unknown) => {
        this.seams.logger.error('Cluster update crashed', {
          meta: { jobId: job.id, error: errText(err) },
        })
        const latest = this.seams.store.load() ?? job
        const index = latest.steps.findIndex(isOpen)
        if (latest.state === 'running') {
          this.stop(latest, index >= 0 ? index : latest.steps.length - 1, {
            status: 'failed',
            reason: 'interrupted',
            detail: `the job crashed: ${errText(err)}`,
          })
        }
      })
      .finally(() => {
        this.running = null
      })
  }

  private async execute(job: ClusterUpdateJob, from: number, resumingHub: boolean): Promise<void> {
    let current = job
    for (let i = from; i < current.steps.length; i += 1) {
      const step = current.steps[i]
      if (step === undefined || step.status === 'skipped' || step.status === 'ok') continue
      const resumed = resumingHub && i === from
      if (!resumed) {
        current = this.patchStep(current, i, {
          status: 'running',
          startedAt: this.seams.now(),
          detail: runningDetail(step),
        })
      }
      const outcome = resumed
        ? await verifyServerStep(
            this.seams,
            null,
            current.targetVersion,
            'resumed after the hub restart',
          )
        : await this.runStep(current, step)
      this.seams.logger.info('Cluster update step finished', {
        tags: step.nodeId !== undefined ? { nodeId: step.nodeId } : {},
        meta: {
          jobId: current.id,
          step: step.kind,
          status: outcome.status,
          detail: outcome.detail,
        },
      })
      if (outcome.status === 'failed') {
        this.stop(current, i, outcome)
        return
      }
      current = this.patchStep(current, i, {
        status: outcome.status,
        detail: outcome.detail,
        finishedAt: this.seams.now(),
        ...(outcome.packages !== undefined ? { packages: outcome.packages } : {}),
      })
    }
    this.finish(current, null)
  }

  private async runStep(job: ClusterUpdateJob, step: ClusterUpdateStep): Promise<StepOutcome> {
    switch (step.kind) {
      case 'backup':
        return runBackupStep(this.seams, `cluster-update ${job.id}`)
      case 'hub-server':
        return runServerStep(this.seams, null, job.targetVersion)
      case 'agent-server': {
        const nodeId = step.nodeId ?? ''
        const topology = await this.seams.readTopology()
        const node = topology.find((n) => n.id === nodeId)
        if (node === undefined || !node.isOnline) {
          return {
            status: 'skipped',
            detail: `${nodeId} went offline before its turn; not touched`,
          }
        }
        return runServerStep(this.seams, nodeId, job.targetVersion)
      }
      case 'addons':
        return runAddonsStep(this.seams)
    }
  }

  private patchStep(
    job: ClusterUpdateJob,
    index: number,
    patch: Partial<ClusterUpdateStep>,
  ): ClusterUpdateJob {
    const next: ClusterUpdateJob = {
      ...job,
      steps: job.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }
    this.seams.store.save(next)
    return next
  }

  /** Fail at `index`: the later steps are skipped and say why. */
  private stop(job: ClusterUpdateJob, index: number, outcome: StepOutcome): void {
    const failedStep = job.steps[index]
    const stoppedAt = failedStep?.nodeId ?? failedStep?.kind ?? 'unknown'
    const steps = job.steps.map((s, i): ClusterUpdateStep => {
      if (i === index) {
        return {
          ...s,
          status: 'failed',
          detail: outcome.detail,
          finishedAt: this.seams.now(),
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          ...(outcome.packages !== undefined ? { packages: outcome.packages } : {}),
        }
      }
      if (i > index && isOpen(s)) {
        return {
          ...s,
          status: 'skipped',
          detail: `not run: ${stoppedAt} failed`,
        }
      }
      return s
    })
    this.seams.logger.warn('Cluster update stopped', {
      meta: {
        jobId: job.id,
        stoppedAt,
        reason: outcome.reason,
        detail: outcome.detail,
      },
    })
    this.finish({ ...job, steps }, { stoppedAt, reason: outcome.reason ?? 'interrupted' })
  }

  private finish(
    job: ClusterUpdateJob,
    failure: {
      readonly stoppedAt: string
      readonly reason: ClusterUpdateFailureReason
    } | null,
  ): void {
    const done: ClusterUpdateJob = {
      ...job,
      state: failure === null ? 'succeeded' : 'failed',
      finishedAt: this.seams.now(),
      ...(failure !== null ? { stoppedAt: failure.stoppedAt, reason: failure.reason } : {}),
    }
    this.seams.store.save(done)
    if (failure === null) {
      this.seams.logger.info('Cluster update succeeded', {
        meta: { jobId: job.id, target: job.targetVersion },
      })
    }
  }
}

function runningDetail(step: ClusterUpdateStep): string {
  switch (step.kind) {
    case 'backup':
      return 'backing up'
    case 'hub-server':
      return 'updating the hub; it restarts and the job resumes on the new boot'
    case 'agent-server':
      return `updating ${step.nodeId ?? 'the agent'} and waiting until it runs the target`
    case 'addons':
      return 'updating the addons on the hub; agents follow by reconciliation'
  }
}
