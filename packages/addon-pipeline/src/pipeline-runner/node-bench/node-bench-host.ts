/**
 * The runner side of the node benchmark (D791): one run per node, started
 * by the orchestrator through `nodePin`, answered at once and polled. Holds
 * the run's status in RAM (a restarted runner forgets it — the orchestrator
 * reads that as `runner-lost` and restores the cluster), stops itself at the
 * deadline whatever the hub does, and deletes the models it downloaded that
 * were not installed before (unless told to keep them).
 */
import os from 'node:os'
import {
  type NodeBenchCell,
  type NodeBenchFingerprint,
  type NodeBenchProgress,
  type NodeBenchRunnerInput,
  NodeBenchRunnerInputSchema,
  type NodeBenchRunnerInputRaw,
  type NodeBenchRunnerStatus,
  type PipelineStepInputOutput,
} from '@camstack/types'
import type { CapacityStallWindow } from '../capacity/capacity-runner.js'
import type { BenchFrameSet } from './bench-frames.js'
import { type BenchDispatchResult, type BenchFrame, NodeBenchDriver } from './node-bench-driver.js'

/** Node CPU % between two calls (all cores), and free RAM %. */
export function createSystemSampler(): () => { cpuPct: number; ramFreePct: number } {
  const totals = (): { idle: number; total: number } =>
    os.cpus().reduce(
      (acc, c) => {
        const t = c.times
        return {
          idle: acc.idle + t.idle,
          total: acc.total + t.user + t.nice + t.sys + t.idle + t.irq,
        }
      },
      { idle: 0, total: 0 },
    )
  let prev = totals()
  return () => {
    const now = totals()
    const total = now.total - prev.total
    const idle = now.idle - prev.idle
    prev = now
    const cpuPct = total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0
    const ramFreePct = Math.round((os.freemem() / os.totalmem()) * 1000) / 10
    return { cpuPct, ramFreePct }
  }
}

export interface NodeBenchHostDeps {
  readonly nodeId: string
  readonly loadFrames: () => Promise<BenchFrameSet>
  readonly dispatch: (args: {
    readonly steps: readonly PipelineStepInputOutput[]
    readonly deviceKey: string
    readonly plane: 'frame' | 'full'
    readonly frame: BenchFrame
  }) => Promise<BenchDispatchResult>
  readonly pipelineSteps: (
    rootModelId: string,
    stepIds: readonly string[],
  ) => Promise<readonly PipelineStepInputOutput[]>
  readonly fingerprint: (deviceKeys: readonly string[]) => Promise<NodeBenchFingerprint>
  /** Detector model copies on the node now, as `modelId/format` keys. */
  readonly installedDetectorModels: () => Promise<ReadonlySet<string>>
  /** Delete one detector model copy (`modelId/format`) the run downloaded. */
  readonly deleteDetectorModel: (key: string) => Promise<void>
  /** Cameras running on this node now (they share the pools). */
  readonly activeCameraIds: () => readonly number[]
  readonly startStallSampler: () => { snapshot: () => CapacityStallWindow; stop: () => void }
  readonly sampleSystem?: () => { cpuPct: number; ramFreePct: number }
  readonly log: (level: 'info' | 'warn', message: string, meta?: Record<string, unknown>) => void
  readonly now?: () => number
  /** Test seam: the pacer's sleep (default a real unref'd timer). */
  readonly sleepUntil?: (t: number) => Promise<void>
}

interface RunState {
  status: NodeBenchRunnerStatus
  stop: boolean
}

/** Runs kept for status reads after they end. */
const KEEP_FINISHED = 5

export class NodeBenchHost {
  private readonly runs = new Map<string, RunState>()

  constructor(private readonly deps: NodeBenchHostDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(raw: NodeBenchRunnerInputRaw): { accepted: true; runId: string } {
    const input = NodeBenchRunnerInputSchema.parse(raw)
    const existing = this.runs.get(input.runId)
    if (existing !== undefined) return { accepted: true, runId: input.runId }
    for (const [id, run] of this.runs) {
      if (run.status.state === 'running') {
        throw new Error(`node bench: run ${id} is measuring this node — one at a time`)
      }
    }
    const state: RunState = {
      stop: false,
      status: {
        runId: input.runId,
        nodeId: this.deps.nodeId,
        state: 'running',
        progress: null,
        cells: [],
        fingerprint: null,
        clip: null,
        activeCameraIds: [...this.deps.activeCameraIds()],
        deletedModels: [],
        error: null,
        startedAtMs: this.now(),
        finishedAtMs: null,
      },
    }
    this.runs.set(input.runId, state)
    this.prune()
    void this.execute(input, state)
    return { accepted: true, runId: input.runId }
  }

  status(runId: string): NodeBenchRunnerStatus | null {
    return this.runs.get(runId)?.status ?? null
  }

  abort(runId: string): { aborted: boolean } {
    const run = this.runs.get(runId)
    if (run === undefined || run.status.state !== 'running') return { aborted: false }
    run.stop = true
    return { aborted: true }
  }

  private prune(): void {
    const finished = [...this.runs.values()]
      .filter((r) => r.status.state !== 'running')
      .toSorted((a, b) => b.status.startedAtMs - a.status.startedAtMs)
    for (const old of finished.slice(KEEP_FINISHED)) this.runs.delete(old.status.runId)
  }

  private patch(state: RunState, patch: Partial<NodeBenchRunnerStatus>): void {
    state.status = { ...state.status, ...patch }
  }

  private noteActiveCameras(state: RunState): void {
    const seen = new Set([...state.status.activeCameraIds, ...this.deps.activeCameraIds()])
    if (seen.size !== state.status.activeCameraIds.length) {
      this.patch(state, { activeCameraIds: [...seen].toSorted((a, b) => a - b) })
    }
  }

  private async execute(input: NodeBenchRunnerInput, state: RunState): Promise<void> {
    const shouldStop = (): boolean => state.stop || this.now() >= input.deadlineAtMs
    const sampler = this.deps.startStallSampler()
    const installedBefore = await this.deps.installedDetectorModels().catch(() => null)
    try {
      this.patch(state, {
        progress: this.preparing(input, 'decoding the bench frames'),
      })
      const deviceKeys = input.devices.map((d) => d.deviceKey)
      const [frameSet, fingerprint] = await Promise.all([
        this.deps.loadFrames(),
        this.deps.fingerprint(deviceKeys).catch(() => null),
      ])
      this.patch(state, { clip: frameSet.clip, fingerprint })
      this.deps.log('info', 'node bench start', {
        runId: input.runId,
        clip: frameSet.clip.id,
        frames: frameSet.frames.length,
        devices: deviceKeys,
        phases: input.phases,
      })
      const driver = new NodeBenchDriver({
        input,
        frames: frameSet.frames,
        dispatch: this.deps.dispatch,
        pipelineSteps: (modelId) => this.deps.pipelineSteps(modelId, input.steps),
        now: () => this.now(),
        sleepUntil:
          this.deps.sleepUntil ??
          ((t) =>
            new Promise((resolve) => {
              const timer = setTimeout(resolve, Math.max(0, t - this.now()))
              timer.unref?.()
            })),
        shouldStop,
        stallSnapshot: sampler.snapshot,
        rssMb: () => Math.round(process.memoryUsage().rss / 1e6),
        sampleSystem: this.deps.sampleSystem ?? createSystemSampler(),
        onProgress: (progress: NodeBenchProgress) => {
          this.noteActiveCameras(state)
          this.patch(state, { progress })
        },
        onCell: (cell: NodeBenchCell) => {
          this.patch(state, { cells: [...state.status.cells, cell] })
          this.deps.log('info', 'node bench cell', {
            runId: input.runId,
            phase: cell.phase,
            deviceKey: cell.deviceKey,
            modelId: cell.modelId,
            ...(cell.phase === 'device'
              ? { kMax: cell.kMax, fps: cell.fps, p95Ms: cell.p95Ms }
              : { maxSessions: cell.maxSessions, stepsFired: cell.stepsFired.join(',') }),
            limitedBy: cell.limitedBy,
          })
        },
      })
      await driver.run()
      this.patch(state, { state: shouldStop() ? 'aborted' : 'done' })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.deps.log('warn', 'node bench failed', { runId: input.runId, error })
      this.patch(state, { state: 'failed', error })
    } finally {
      sampler.stop()
      await this.cleanupModels(input, state, installedBefore)
      this.patch(state, { finishedAtMs: this.now(), progress: null })
    }
  }

  private preparing(input: NodeBenchRunnerInput, message: string): NodeBenchProgress {
    return {
      phase: 'preparing',
      deviceKey: null,
      modelId: null,
      load: null,
      cellsDone: 0,
      cellsTotal:
        (input.phases.includes('device')
          ? input.devices.reduce((n, d) => n + d.modelIds.length, 0)
          : 0) + (input.phases.includes('pipeline') ? input.devices.length : 0),
      message,
    }
  }

  /** Delete the candidate detectors the run fetched that were not installed before. */
  private async cleanupModels(
    input: NodeBenchRunnerInput,
    state: RunState,
    before: ReadonlySet<string> | null,
  ): Promise<void> {
    if (input.keepDownloadedModels || before === null) return
    const after = await this.deps.installedDetectorModels().catch(() => null)
    if (after === null) return
    const candidates = new Set(input.devices.flatMap((d) => d.modelIds))
    const fetched = [...after].filter(
      (key) => candidates.has(key.split('/')[0] ?? '') && !before.has(key),
    )
    const deleted: string[] = []
    for (const key of fetched) {
      try {
        await this.deps.deleteDetectorModel(key)
        deleted.push(key)
      } catch (err) {
        this.deps.log('warn', 'node bench: could not delete a downloaded model', {
          model: key,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (deleted.length > 0) this.patch(state, { deletedModels: deleted })
  }
}
