/**
 * `training` — the cloud-training orchestrator (D805). Hub-only.
 *
 * Wires the engine to `ctx.api` and the hub's disk, provides the `training`
 * capability and the Training page, and runs the reconcile loop: once at boot
 * (a restart loses nothing — the job rows and the provider's jobKey tags are
 * the whole truth), then every 30 s, plus a daily orphan sweep.
 */
import path from 'node:path'
import {
  type AddonInitResult,
  type AddonPageDeclaration,
  addonPagesSourceCapability,
  BaseAddon,
  type IAddonPageProvider,
  type ITrainingOrchestrator,
  trainingCapability,
} from '@camstack/types'
import { corpusPort, datasetPort, pinPort, providerPort, registryPort } from './api-ports.js'
import { createDiskArtifacts } from './artifact-staging.js'
import { BASE_MODELS, publicBaseModel } from './base-models.js'
import { ORPHAN_SWEEP_INTERVAL_MS, RECONCILE_INTERVAL_MS, TrainingEngine } from './job-engine.js'
import { planJob } from './plan-job.js'
import type { EnginePorts } from './ports.js'
import { ReturnFlow } from './return-flow.js'
import { trainingRecordKinds } from './record-kinds.js'
import { RecordsJobStore } from './stores.js'
import { TRAINER_SOURCE } from './trainer-source.js'

/** The first orphan sweep waits for the providers to register after a boot. */
const FIRST_SWEEP_DELAY_MS = 5 * 60_000

export class TrainingAddon extends BaseAddon<Record<string, never>> {
  readonly pages: readonly AddonPageDeclaration[] = [
    {
      id: 'training',
      label: 'Training',
      icon: 'graduation-cap',
      path: '/addon/training',
      remoteName: 'addon_training_page',
      bundle: 'remoteEntry.js',
      section: 'detection',
    },
  ] as const

  private engine: TrainingEngine | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  private ticking = false

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<AddonInitResult> {
    const api = this.ctx.api
    const peer = this.ctx.peerBytes
    const records = this.ctx.records
    if (peer === undefined) throw new Error('training needs the peer-bytes facility')
    if (records === undefined) throw new Error('training needs ctx.records')
    await records.declare(trainingRecordKinds)
    const logger = this.ctx.logger
    const ports: EnginePorts = {
      provider: providerPort(api),
      datasets: datasetPort(api),
      corpus: corpusPort(api),
      jobs: RecordsJobStore.of(records, logger),
      artifacts: createDiskArtifacts(path.join(this.ctx.dataDir, 'training', 'jobs'), peer),
      registry: registryPort(api),
      pins: pinPort(api),
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      logger,
    }
    const engine = new TrainingEngine(ports, TRAINER_SOURCE)
    const flow = new ReturnFlow(ports, engine.mutator)
    this.engine = engine

    const provider: ITrainingOrchestrator = {
      listBaseModels: async () => BASE_MODELS.map(publicBaseModel),
      planJob: async (request) =>
        (await planJob(request, { corpus: ports.corpus, provider: ports.provider })).plan,
      startJob: async (input) => engine.startJob(input),
      startJobBatch: async (input) => engine.startJobBatch(input),
      listJobs: async () => ports.jobs.list(),
      getJob: async ({ id }) => ports.jobs.get(id),
      cancelJob: async ({ id }) => engine.cancelJob(id),
      getJobResult: async ({ id }) => {
        const job = await ports.jobs.get(id)
        return job === null ? null : flow.readResult(job)
      },
      listCanaryTargets: async () =>
        (await ports.pins.listDetectorDevices()).map((d) => ({
          nodeId: d.nodeId,
          deviceKey: d.deviceKey,
          pinnedModelId: d.pinnedModelId,
        })),
      registerResult: async ({ id, canaryAccelerators }) => flow.register(id, canaryAccelerators),
      canaryResult: async ({ id, accelerators }) => flow.canary(id, accelerators),
      rollbackCanary: async ({ id }) => flow.rollback(id),
      discardResult: async ({ id }) => flow.discard(id),
    }
    const pagesProvider: IAddonPageProvider = { id: this.ctx.id, listPages: () => this.pages }

    this.schedule(0, RECONCILE_INTERVAL_MS, () => this.reconcile())
    this.schedule(FIRST_SWEEP_DELAY_MS, ORPHAN_SWEEP_INTERVAL_MS, async () => {
      const swept = await engine.sweepOrphans()
      if (swept.length > 0)
        logger.warn('training orphan sweep stopped cloud jobs', { meta: { swept: [...swept] } })
    })
    return {
      providers: [
        { capability: trainingCapability, provider },
        { capability: addonPagesSourceCapability, provider: pagesProvider },
      ],
    }
  }

  protected async onShutdown(): Promise<void> {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.engine = null
  }

  private async reconcile(): Promise<void> {
    if (this.ticking || this.engine === null) return
    this.ticking = true
    try {
      await this.engine.tick()
    } finally {
      this.ticking = false
    }
  }

  /** A self-rescheduling timer that never overlaps itself and never throws out. */
  private schedule(firstDelayMs: number, everyMs: number, body: () => Promise<void>): void {
    const run = (): void => {
      void body()
        .catch((err: unknown) => {
          this.ctx.logger.warn('training scheduled pass failed', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
        .finally(() => {
          if (this.engine !== null) this.timers.push(setTimeout(run, everyMs))
        })
    }
    this.timers.push(setTimeout(run, firstDelayMs))
  }
}
