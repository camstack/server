/**
 * THE PLACEMENT CENSUS IS PARALLEL, BOUNDED PER NODE, AND SAYS WHAT IT COST (D440).
 *
 * `runPlacementReconcile` asked every runner for its attached cameras one
 * after the other, with no bound, and ran at the head of every motion
 * dispatch. A node whose event loop was busy therefore became every camera's
 * dispatch latency, and a census that merely took long produced no line at
 * all (81 of the 163 dispatches over 2 s in 12 h had nothing in their window).
 */
import type { IScopedLogger, NodePinnedRequestOptions } from '@camstack/types'
import { CAP_NODE_PIN_CONTEXT_KEY } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECONCILE_NODE_BUDGET_MS } from '../dispatch-timing.js'
import { ReconcileController, type ReconcileControllerDeps } from '../reconcile-controller.js'

interface LogLine {
  readonly message: string
  readonly meta: Record<string, unknown>
}

function capturingLogger(lines: LogLine[]): IScopedLogger {
  const push = (message: string, opts?: { meta?: Record<string, unknown> }): void => {
    lines.push({ message, meta: opts?.meta ?? {} })
  }
  const log: Partial<IScopedLogger> = { info: push, warn: push, error: push, debug: push }
  log.withTags = () => log as IScopedLogger
  return log as IScopedLogger
}

interface NodeAnswer {
  /** How long the node takes to answer `getLocalCameras`. */
  readonly ms: number
  readonly attached: readonly number[]
}

interface Harness {
  readonly controller: ReconcileController
  readonly lines: LogLine[]
  readonly detached: { nodeId: string; deviceId: number; at: number }[]
  readonly dropped: number[]
  readonly deregistered: number[]
}

function makeHarness(opts: {
  readonly nodes: Record<string, NodeAnswer>
  readonly assigned?: Record<number, string>
  readonly idleSessionDevices?: readonly number[]
  readonly detachMs?: number
}): Harness {
  const lines: LogLine[] = []
  const detached: Harness['detached'] = []
  const dropped: number[] = []
  const deregistered: number[] = []
  const nodeIds = Object.keys(opts.nodes)
  const assignedNodeById = new Map<number, string>(
    Object.entries(opts.assigned ?? {}).map(([id, node]) => [Number(id), node]),
  )
  const api = {
    pipelineRunner: {
      getLocalCameras: {
        query: (_input: undefined, pin: NodePinnedRequestOptions | undefined) => {
          const nodeId = String(pin?.context?.[CAP_NODE_PIN_CONTEXT_KEY] ?? '')
          const answer = opts.nodes[nodeId]
          if (!answer) return Promise.reject(new Error(`unknown node ${nodeId}`))
          return new Promise<readonly number[]>((resolve) =>
            setTimeout(() => resolve(answer.attached), answer.ms),
          )
        },
      },
    },
  }
  const deps = {
    api: () => api,
    ledger: {
      snapshotForReconcile: () => ({ assignedNodeById, dispatching: new Set<number>() }),
      dropAssignment: (deviceId: number) => {
        dropped.push(deviceId)
      },
    },
    topology: { collectRunnerNodeIds: () => nodeIds },
    logger: capturingLogger(lines),
    detachOn: async (nodeId: string, deviceId: number) => {
      if (opts.detachMs !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, opts.detachMs))
      }
      detached.push({ nodeId, deviceId, at: Date.now() })
    },
    activeDeviceIds: () => new Set(opts.idleSessionDevices ?? []),
    isSessionCamera: () => true,
    isIdleSessionCamera: (deviceId: number) => (opts.idleSessionDevices ?? []).includes(deviceId),
    isMotionWatchAttachment: () => false,
    deregisterSession: (deviceId: number) => {
      deregistered.push(deviceId)
    },
  } as unknown as ReconcileControllerDeps
  return { controller: new ReconcileController(deps), lines, detached, dropped, deregistered }
}

async function census(h: Harness, ms: number): Promise<void> {
  const run = h.controller.reconcilePlacementFromRunners()
  await vi.advanceTimersByTimeAsync(ms)
  await run
}

describe('D440 — the placement census', () => {
  const T0 = 1_000_000
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks every runner in parallel — three nodes at 400 ms cost 400 ms, not 1 200', async () => {
    const h = makeHarness({
      nodes: {
        hub: { ms: 400, attached: [] },
        'agent-a': { ms: 400, attached: [] },
        mac: { ms: 400, attached: [] },
      },
    })
    let settled = false
    const run = h.controller.reconcilePlacementFromRunners().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(400)
    expect(settled).toBe(true)
    await run
  })

  it('a node past the per-node budget is skipped and NAMED, and its assignments are never dropped', async () => {
    const h = makeHarness({
      nodes: {
        hub: { ms: 50, attached: [] },
        mac: { ms: 10_000, attached: [101] },
      },
      assigned: { 101: 'mac' },
    })
    let settled = false
    const run = h.controller.reconcilePlacementFromRunners().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(RECONCILE_NODE_BUDGET_MS)
    expect(settled).toBe(true)
    await run

    // The mac never reported: truth unknown, 101 stays assigned there.
    expect(h.dropped).toEqual([])
    expect(h.deregistered).toEqual([])
    const slow = h.lines.find((l) => l.message === 'placement reconcile: runner census was slow')
    expect(slow).toBeDefined()
    const nodes = slow?.meta['nodes'] as readonly { nodeId: string; outcome: string; ms: number }[]
    expect(nodes.find((n) => n.nodeId === 'mac')?.outcome).toBe('budget-exceeded')
    expect(nodes.find((n) => n.nodeId === 'mac')?.ms).toBe(RECONCILE_NODE_BUDGET_MS)
    expect(nodes.find((n) => n.nodeId === 'hub')?.outcome).toBe('reported')
  })

  it('a quick census says nothing', async () => {
    const h = makeHarness({
      nodes: { hub: { ms: 50, attached: [] }, mac: { ms: 80, attached: [] } },
    })
    await census(h, 100)
    expect(h.lines.filter((l) => l.message.includes('runner census'))).toEqual([])
  })

  it('detaches orphans in parallel — two orphans at 300 ms each cost 300 ms', async () => {
    const h = makeHarness({
      nodes: {
        hub: { ms: 10, attached: [101] },
        mac: { ms: 10, attached: [102] },
      },
      idleSessionDevices: [101, 102],
      detachMs: 300,
    })
    await census(h, 310)
    expect(h.detached.map((d) => d.deviceId).toSorted()).toEqual([101, 102])
    expect(h.detached.map((d) => d.at - T0)).toEqual([310, 310])
  })
})
