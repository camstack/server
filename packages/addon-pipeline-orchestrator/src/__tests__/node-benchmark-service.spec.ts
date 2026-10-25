/**
 * D791 — the node benchmark lifecycle: one run cluster-wide, the restore
 * manifest persisted BEFORE benchmark mode changes anything, the cluster
 * restored on every way out (completion, abort, deadline, lost node, lost
 * runner, drain timeout, hub restart), and results stored only for what was
 * really measured.
 */
import type {
  IScopedLogger,
  NodeBenchCell,
  NodeBenchmarkManifest,
  NodeBenchmarkResult,
  NodeBenchmarkRun,
  NodeBenchRunnerInputRaw,
  NodeBenchRunnerStatus,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { NodeBenchmarkPersistence } from '../node-benchmark/node-benchmark-store.js'
import {
  NodeBenchmarkService,
  type NodeBenchRunnerClient,
  publishableCells,
} from '../node-benchmark/node-benchmark-service.js'

const logger: IScopedLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as IScopedLogger

class MemoryPersistence implements NodeBenchmarkPersistence {
  manifest: NodeBenchmarkManifest | null = null
  runs: NodeBenchmarkRun[] = []
  results: NodeBenchmarkResult[] = []
  failManifestWrite = false
  readonly log: string[] = []
  async load(): Promise<void> {}
  readManifest(): NodeBenchmarkManifest | null {
    return this.manifest
  }
  async writeManifest(m: NodeBenchmarkManifest): Promise<void> {
    if (this.failManifestWrite) throw new Error('store down')
    this.log.push('manifest-written')
    this.manifest = m
  }
  async clearManifest(): Promise<void> {
    this.log.push('manifest-cleared')
    this.manifest = null
  }
  async recordRun(run: NodeBenchmarkRun): Promise<void> {
    this.runs = [run, ...this.runs.filter((r) => r.runId !== run.runId)]
  }
  listRuns(): readonly NodeBenchmarkRun[] {
    return this.runs
  }
  async writeResults(rows: readonly NodeBenchmarkResult[]): Promise<void> {
    this.results.push(...rows)
  }
  listResults(): readonly NodeBenchmarkResult[] {
    return this.results
  }
  async deleteResult(): Promise<boolean> {
    return false
  }
}

const deviceCell: NodeBenchCell = {
  phase: 'device',
  deviceKey: 'coreml:all',
  modelId: 'yolov9s-640',
  p50Ms: 12,
  p95Ms: 18,
  p99Ms: 22,
  fps: 80,
  kMax: 8,
  limitedBy: 'p95',
  warmupMs: 900,
  ramp: [],
}
const pipelineCell = (stepsFired: string[]): NodeBenchCell => ({
  phase: 'pipeline',
  deviceKey: 'coreml:all',
  modelId: 'yolov9s-640',
  steps: ['face-detection'],
  maxSessions: 5,
  limitedBy: 'cpu',
  stepsFired,
  warmupMs: 1000,
  ramp: [],
})

function runnerStatus(
  state: NodeBenchRunnerStatus['state'],
  cells: NodeBenchCell[] = [],
  activeCameraIds: number[] = [],
): NodeBenchRunnerStatus {
  return {
    runId: 'r1',
    nodeId: 'mac',
    state,
    progress: null,
    cells,
    fingerprint: null,
    clip: null,
    activeCameraIds,
    deletedModels: [],
    error: state === 'failed' ? 'pool died' : null,
    startedAtMs: 0,
    finishedAtMs: null,
  }
}

interface Harness {
  readonly service: NodeBenchmarkService
  readonly persistence: MemoryPersistence
  readonly runner: NodeBenchRunnerClient & {
    started: NodeBenchRunnerInputRaw[]
    aborted: string[]
    statuses: (NodeBenchRunnerStatus | null)[]
  }
  readonly events: string[]
  readonly clock: { t: number }
  online: Set<string>
  onNode: number[][]
  readonly settle: () => Promise<void>
}

function harness(
  opts: {
    statuses?: (NodeBenchRunnerStatus | null)[]
    onNode?: number[][]
    runnerLostAfter?: number
  } = {},
): Harness {
  const persistence = new MemoryPersistence()
  const events: string[] = []
  const clock = { t: 1_000_000 }
  const runner = {
    started: [] as NodeBenchRunnerInputRaw[],
    aborted: [] as string[],
    statuses: opts.statuses ?? [runnerStatus('running'), runnerStatus('done', [deviceCell])],
    async start(_nodeId: string, input: NodeBenchRunnerInputRaw) {
      events.push('runner-start')
      this.started.push(input)
    },
    async status() {
      return this.statuses.length > 1 ? (this.statuses.shift() ?? null) : (this.statuses[0] ?? null)
    },
    async abort(_nodeId: string, runId: string) {
      events.push('runner-abort')
      this.aborted.push(runId)
    },
  }
  const h: Harness = {
    service: null as unknown as NodeBenchmarkService,
    persistence,
    runner,
    events,
    clock,
    online: new Set(['hub', 'mac']),
    onNode: opts.onNode ?? [[]],
    settle: async () => {
      for (let i = 0; i < 200; i++) await Promise.resolve()
    },
  }
  const service = new NodeBenchmarkService({
    logger,
    persistence,
    runner,
    isNodeOnline: (n) => h.online.has(n),
    listDeviceKeys: async () => ['coreml:all'],
    cameraFacts: async () => [
      { deviceId: 1, placedNodeId: 'mac', nodePin: null, frameSourceNodes: ['hub', 'mac'] },
      { deviceId: 2, placedNodeId: 'hub', nodePin: 'mac', frameSourceNodes: ['hub', 'mac'] },
    ],
    headroom: async () => ({ sessionsNow: 1, otherNodesCapacitySessions: 4 }),
    drain: async (ids) => {
      events.push(`drain:${[...ids].join(',')}`)
    },
    camerasOnNode: async () =>
      h.onNode.length > 1 ? (h.onNode.shift() ?? []) : (h.onNode[0] ?? []),
    restorePins: async (ids) => {
      events.push(`restore:${[...ids].join(',')}`)
    },
    onResultsWritten: (n) => events.push(`results:${n}`),
    onModeChanged: (n) => events.push(`mode:${n ?? 'off'}`),
    now: () => clock.t,
    newRunId: () => 'r1',
    sleep: async (ms) => {
      clock.t += ms
    },
    pollIntervalMs: 1000,
    drainTimeoutMs: 10_000,
    runnerLostAfter: opts.runnerLostAfter ?? 3,
  })
  Object.assign(h, { service })
  return h
}

const PLAN = { nodeId: 'mac', devices: [{ deviceKey: 'coreml:all', modelIds: ['yolov9s-640'] }] }

async function until(h: Harness, pred: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !pred(); i++) await h.settle()
}

describe('NodeBenchmarkService', () => {
  it('a completed run: manifest first, mode on, drain, measure, restore, results, manifest cleared last', async () => {
    const h = harness()
    const started = await h.service.start(PLAN)
    expect(started).toEqual({ kind: 'started', runId: 'r1' })
    expect(h.persistence.log[0]).toBe('manifest-written')
    expect(h.events[0]).toBe('mode:mac')
    await until(h, () => h.service.status().run?.state === 'done')
    expect(h.events).toEqual([
      'mode:mac',
      'drain:1,2',
      'runner-start',
      'mode:off',
      'restore:1,2',
      'results:mac',
    ])
    expect(h.persistence.log.at(-1)).toBe('manifest-cleared')
    expect(h.persistence.results).toHaveLength(1)
    expect(h.persistence.results[0]).toMatchObject({ nodeId: 'mac', partialRun: false })
    expect(h.service.modeNodeId()).toBeNull()
    expect(h.service.status().run).toMatchObject({ endReason: 'completed', resultIds: ['r1:0'] })
  })

  it('a manifest that cannot be persisted changes nothing', async () => {
    const h = harness()
    h.persistence.failManifestWrite = true
    await expect(h.service.start(PLAN)).rejects.toThrow(/nothing changed/)
    expect(h.service.modeNodeId()).toBeNull()
    expect(h.events).toEqual([])
    // and the lock is free again
    h.persistence.failManifestWrite = false
    expect((await h.service.start(PLAN)).kind).toBe('started')
  })

  it('one run at a time, cluster-wide — a second start is refused with the preflight', async () => {
    const h = harness({ statuses: [runnerStatus('running')] })
    await h.service.start(PLAN)
    const second = await h.service.start({ ...PLAN, nodeId: 'hub' })
    expect(second.kind).toBe('refused')
    if (second.kind === 'refused') {
      expect(second.preflight.refusals.map((r) => r.kind)).toContain('benchmark-active')
    }
  })

  it('operator abort: the runner is told to stop, the cluster restored, finished cells kept as partial', async () => {
    const h = harness({ statuses: [runnerStatus('running', [deviceCell])] })
    await h.service.start(PLAN)
    await until(h, () => h.runner.started.length === 1)
    expect(h.service.abort('r1')).toEqual({ aborted: true })
    await until(h, () => h.service.status().run?.state === 'aborted')
    expect(h.runner.aborted).toEqual(['r1'])
    expect(h.service.status().run?.endReason).toBe('operator-abort')
    expect(h.service.modeNodeId()).toBeNull()
    expect(h.persistence.manifest).toBeNull()
    expect(h.persistence.results[0]?.partialRun).toBe(true)
  })

  it('the deadline ends the run and restores', async () => {
    const h = harness({ statuses: [runnerStatus('running')] })
    await h.service.start({ ...PLAN, budgetMinutes: 10 })
    await until(h, () => h.service.status().run?.state === 'aborted')
    expect(h.service.status().run?.endReason).toBe('deadline')
    expect(h.runner.aborted).toEqual(['r1'])
    expect(h.persistence.manifest).toBeNull()
  })

  it('a node that goes offline ends the run as node-lost, restored', async () => {
    const h = harness({ statuses: [null], runnerLostAfter: 1_000_000 })
    await h.service.start(PLAN)
    await until(h, () => h.runner.started.length === 1)
    h.online.delete('mac')
    await until(h, () => h.service.status().run?.state === 'aborted')
    expect(h.service.status().run?.endReason).toBe('node-lost')
    expect(h.service.modeNodeId()).toBeNull()
  })

  it('a runner that forgets the run (restarted) ends it as runner-lost', async () => {
    const h = harness({ statuses: [null] })
    await h.service.start(PLAN)
    await until(h, () => h.service.status().run?.state === 'aborted')
    expect(h.service.status().run?.endReason).toBe('runner-lost')
    expect(h.persistence.manifest).toBeNull()
  })

  it('a drain that never empties the node is refused and restored, the runner never started', async () => {
    const h = harness({ onNode: [[1]] })
    await h.service.start(PLAN)
    await until(h, () => h.service.status().run?.state === 'aborted')
    expect(h.service.status().run?.endReason).toBe('drain-timeout')
    expect(h.runner.started).toEqual([])
    expect(h.service.modeNodeId()).toBeNull()
  })

  it('a hub restart mid-run: the next process finds the manifest and restores at boot', async () => {
    const h = harness()
    h.persistence.manifest = {
      runId: 'old',
      nodeId: 'mac',
      startedAtMs: 1,
      deadlineAtMs: 2,
      plan: {
        nodeId: 'mac',
        devices: [{ deviceKey: 'coreml:all', modelIds: ['m'] }],
        phases: ['device'],
        steps: [],
        fpsPerStream: 10,
        budgetMinutes: 45,
        keepDownloadedModels: false,
        acceptInsufficientHeadroom: false,
      },
      moved: [1],
      staying: [],
    }
    await h.service.reconcile('boot')
    expect(h.runner.aborted).toEqual(['old'])
    expect(h.events).toContain('restore:1')
    expect(h.persistence.manifest).toBeNull()
    expect(h.persistence.runs[0]).toMatchObject({ runId: 'old', endReason: 'hub-restart' })
    expect(h.service.modeNodeId()).toBeNull()
  })

  it('a manifest left behind by a run that DID finish is only cleared', async () => {
    const h = harness()
    await h.service.start(PLAN)
    await until(h, () => h.service.status().run?.state === 'done')
    const finished = h.persistence.runs[0]
    h.persistence.manifest = { ...(await h.service.preflight(PLAN), {}), runId: 'r1' } as never
    h.runner.aborted.length = 0
    await h.service.reconcile('tick')
    expect(h.persistence.manifest).toBeNull()
    expect(h.runner.aborted).toEqual([])
    expect(h.persistence.runs[0]).toBe(finished)
  })

  it('the preflight lists the cameras placed on or pinned to the node, and starts nothing', async () => {
    const h = harness()
    const preflight = await h.service.preflight(PLAN)
    expect(preflight.moving.map((c) => c.deviceId)).toEqual([1, 2])
    expect(preflight.canStart).toBe(true)
    const hub = await h.service.preflight({ ...PLAN, nodeId: 'hub' })
    expect(hub.moving).toEqual([{ deviceId: 2, placedOnNode: true, pinnedToNode: false }])
    expect(h.events).toEqual([])
    expect(h.persistence.manifest).toBeNull()
  })

  it('a hub run is always contaminated (its duties never stop)', async () => {
    const h = harness()
    await h.service.start({ ...PLAN, nodeId: 'hub' })
    await until(h, () => h.service.status().run?.state === 'done')
    expect(h.persistence.results[0]?.contaminated).toBe(true)
  })
})

describe('publishableCells', () => {
  it('drops a pipeline cell whose requested steps never fired, and names them', () => {
    const out = publishableCells([deviceCell, pipelineCell([])], ['face-detection'])
    expect(out.kept).toEqual([deviceCell])
    expect(out.unfired).toEqual(['face-detection'])
  })
  it('keeps a pipeline cell whose every requested step fired', () => {
    const cell = pipelineCell(['face-detection'])
    expect(publishableCells([cell], ['face-detection']).kept).toEqual([cell])
  })
})
