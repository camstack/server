/**
 * D441: the agent-load census asks every runner in PARALLEL, and a census that
 * skipped a node says so where the hub can see it.
 *
 * `collectAgentLoad` swept the runners in sequence, each under its own
 * `agentLoadTimeoutMs` budget (4 s). On 2026-09-10 18:39:49 three cameras
 * dispatched with `balanceMs 9205` identical — two nodes past the budget in
 * turn plus a third — and the only line about it was at `debug`, which the hub
 * does not write. These tests pin the two properties that fix that: the
 * census costs one budget, not one per node, and a skipped node is reported at
 * WARN with the cost of every node.
 */
import type { AddonApi, IScopedLogger, RunnerLocalLoad } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentLoadService } from '../agent-load-service.js'
import type { RunnerLoadAnswer } from '../camera-sensors/motion-slice-gate.js'
import type { NodeTopologyService } from '../node-topology.js'

const BUDGET_MS = 100

interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
}

function capturingLogger(lines: LogLine[]): IScopedLogger {
  const at =
    (level: LogLine['level']) =>
    (message: string, opts?: { meta?: Record<string, unknown> }): void => {
      lines.push({ level, message, meta: opts?.meta ?? {} })
    }
  const log: Partial<IScopedLogger> = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  }
  log.withTags = () => log as IScopedLogger
  return log as IScopedLogger
}

function fakeLoad(nodeId: string): RunnerLocalLoad {
  return {
    nodeId,
    attachedCameras: 0,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices: [],
    hardware: { hasGpu: false },
  }
}

type NodeAnswer = () => Promise<RunnerLocalLoad>

const never: NodeAnswer = () =>
  new Promise<never>(() => {
    /* a wedged runner: neither resolves nor rejects */
  })

function answersAfter(nodeId: string, ms: number): NodeAnswer {
  return () => new Promise<RunnerLocalLoad>((r) => setTimeout(() => r(fakeLoad(nodeId)), ms))
}

function makeService(
  nodes: Record<string, NodeAnswer>,
  lines: LogLine[],
  onCensus?: (entries: readonly RunnerLoadAnswer[]) => void,
): AgentLoadService {
  const api = {
    pipelineRunner: {
      getLocalLoad: {
        query: async (input: { readonly nodeId: string }) => nodes[input.nodeId]?.(),
      },
    },
  } as unknown as AddonApi
  const topology = {
    knownRunnerNodeIds: () => Object.keys(nodes),
    isNodeEnabled: () => true,
  } as unknown as NodeTopologyService
  return new AgentLoadService({
    api: () => api,
    topology,
    logger: capturingLogger(lines),
    readGlobalSettings: () => ({ agentLoadTimeoutMs: BUDGET_MS }),
    ...(onCensus === undefined ? {} : { onCensus }),
  })
}

describe('D441 — the agent-load census is parallel and reports what it skipped', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('two wedged runners cost ONE budget, not one each', async () => {
    const lines: LogLine[] = []
    const svc = makeService(
      { 'agent-a': never, 'agent-b': never, hub: answersAfter('hub', 10) },
      lines,
    )

    let result: readonly RunnerLocalLoad[] | undefined
    const pending = svc.collectAgentLoad().then((r) => {
      result = r
    })
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    await pending

    expect(result?.map((l) => l.nodeId)).toEqual(['hub'])
  })

  it('the answers keep the topology order whatever order they land in', async () => {
    const lines: LogLine[] = []
    const svc = makeService(
      { 'agent-a': answersAfter('agent-a', 50), hub: answersAfter('hub', 5) },
      lines,
    )

    const pending = svc.collectAgentLoad()
    await vi.advanceTimersByTimeAsync(60)

    expect((await pending).map((l) => l.nodeId)).toEqual(['agent-a', 'hub'])
  })

  it('a census that skipped a node says so at WARN, with every node cost', async () => {
    const lines: LogLine[] = []
    const svc = makeService({ 'agent-a': never, hub: answersAfter('hub', 10) }, lines)

    const pending = svc.collectAgentLoad()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    await pending

    const line = lines.find((l) => l.message === 'agent load census skipped a runner')
    expect(line?.level).toBe('warn')
    expect(line?.meta['budgetMs']).toBe(BUDGET_MS)
    expect(line?.meta['skipped']).toEqual(['agent-a'])
    const nodes = line?.meta['nodes'] as Record<string, unknown>
    expect(nodes['agent-a']).toEqual({ ms: BUDGET_MS, outcome: 'budget-exceeded' })
    expect(nodes['hub']).toEqual({ ms: 10, outcome: 'reported' })
  })

  it('a runner whose read REJECTS is skipped and reported as failed, with the error', async () => {
    const lines: LogLine[] = []
    const svc = makeService(
      {
        'agent-a': () => Promise.reject(new Error('agent unreachable')),
        hub: answersAfter('hub', 10),
      },
      lines,
    )

    const pending = svc.collectAgentLoad()
    await vi.advanceTimersByTimeAsync(20)
    expect((await pending).map((l) => l.nodeId)).toEqual(['hub'])

    const line = lines.find((l) => l.message === 'agent load census skipped a runner')
    const nodes = line?.meta['nodes'] as Record<string, unknown>
    expect(nodes['agent-a']).toEqual({ ms: 0, outcome: 'failed', error: 'agent unreachable' })
  })

  it('a healthy census logs nothing at warn', async () => {
    const lines: LogLine[] = []
    const svc = makeService(
      { 'agent-a': answersAfter('agent-a', 5), hub: answersAfter('hub', 5) },
      lines,
    )

    const pending = svc.collectAgentLoad()
    await vi.advanceTimersByTimeAsync(10)
    await pending

    expect(lines.filter((l) => l.level === 'warn')).toEqual([])
  })

  it('hands every node to the motion-slice gate, an unanswered one as null (D696)', async () => {
    const lines: LogLine[] = []
    const seen: RunnerLoadAnswer[][] = []
    const svc = makeService({ 'agent-a': never, hub: answersAfter('hub', 10) }, lines, (e) =>
      seen.push([...e]),
    )
    const pending = svc.collectAgentLoad()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    await pending
    expect(seen).toEqual([
      [
        { nodeId: 'agent-a', load: null },
        { nodeId: 'hub', load: fakeLoad('hub') },
      ],
    ])
  })
})
