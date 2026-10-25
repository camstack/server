/**
 * `NodeStressController` — the collection, the mode gate, and the three things
 * the pure module cannot check: that `observe` moves NOTHING, that a stale
 * sample stops counting, and that a saturated node with nowhere to go still
 * says so out loud.
 *
 * The test doubles are `as unknown as <Iface>` — the documented boundary this
 * repo already uses for a fake `AddonContext`: the controller touches four
 * methods of interfaces with dozens, and implementing the rest would be
 * ceremony that hides which four actually matter.
 */

import type { CameraMetrics, IScopedLogger, RunnerCameraConfig } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NODE_STRESS_THRESHOLDS } from '../node-stress.js'
import { NodeStressController } from '../node-stress-controller.js'
import { NodeStressMoveLedger } from '../node-stress-move-ledger.js'
import { orchestratorRecordKinds } from '../record-kinds.js'
import type { NodeTopologyService } from '../node-topology.js'
import type { PipelineSettingsStore } from '../pipeline-settings-store.js'
import type { PlacementLedger } from '../placement-ledger.js'
import { type FakeRecords, makeOrchestratorRecords } from './fake-records.js'

const T = DEFAULT_NODE_STRESS_THRESHOLDS

function metrics(over: Partial<CameraMetrics> = {}): CameraMetrics {
  return {
    detectionMode: 'on-motion',
    configuredFps: 5,
    actualFps: 5,
    queueDepth: 0,
    avgInferenceTimeMs: 30,
    droppedFrames: 0,
    phase: 'active',
    ...over,
  }
}

interface MoveRecord {
  readonly nodeId: string
  readonly deviceId: number
}

interface HarnessOptions {
  readonly attachFails?: boolean
  /** Share fake records between two harnesses to model a RESTART. */
  readonly records?: FakeRecords
}

interface Harness {
  readonly controller: NodeStressController
  readonly records: FakeRecords
  readonly moves: MoveRecord[]
  readonly detaches: MoveRecord[]
  readonly logs: string[]
  setNow(value: number): void
  setMode(mode: string): void
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  let now = 0
  let mode = 'failover'
  const appliedMoves: MoveRecord[] = []
  const detaches: MoveRecord[] = []
  const logs: string[] = []
  const assignments: Record<number, string> = { 101: 'macmini', 102: 'macmini' }

  const record = (message: string): void => {
    logs.push(message)
  }
  const logger = {
    info: record,
    warn: record,
    error: record,
    debug: () => {},
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger

  const ledger = {
    getAssignment: (deviceId: number) =>
      assignments[deviceId] ? { agentNodeId: assignments[deviceId] } : null,
    getConfig: (deviceId: number) => ({ deviceId }),
    assignmentsView: () =>
      new Map(
        Object.entries(assignments).map(
          ([id, nodeId]) => [Number(id), { agentNodeId: nodeId }] as const,
        ),
      ),
    recordAssignment: (deviceId: number, nodeId: string) => {
      assignments[deviceId] = nodeId
    },
  } as unknown as PlacementLedger

  const topology = {
    detectionEligibleNodes: () => ['macmini', 'hub'],
  } as unknown as NodeTopologyService

  const settingsStore = {
    buildNodeCaps: async () => ({}),
  } as unknown as PipelineSettingsStore

  const records = options.records ?? (await makeOrchestratorRecords())
  const moves = new NodeStressMoveLedger({
    kind: records.records.kind(orchestratorRecordKinds['node-stress-moves']),
    logger,
  })

  const controller = new NodeStressController({
    ledger,
    moves,
    topology,
    settingsStore,
    logger,
    attach: async (nodeId: string, config: RunnerCameraConfig) => {
      if (options.attachFails) throw new Error('attach exploded')
      appliedMoves.push({ nodeId, deviceId: config.deviceId })
    },
    detach: async (nodeId: string, deviceId: number) => {
      detaches.push({ nodeId, deviceId })
    },
    readPipelinePin: async () => null,
    readGlobalSettings: () => ({ nodeStressMode: mode }),
    now: () => now,
  })

  return {
    controller,
    records,
    moves: appliedMoves,
    detaches,
    logs,
    setNow: (value) => {
      now = value
    },
    setMode: (value) => {
      mode = value
    },
  }
}

/**
 * Drive `nodeId` to `saturated` by holding a full queue continuously. Five
 * observations, because the ladder is walked one rung at a time: cross, serve
 * the enter dwell, cross again, serve the saturate dwell.
 */
async function saturate(h: Harness, withIdleHub = false): Promise<number> {
  const steps = [
    0,
    10_000,
    T.enterDwellMs,
    T.enterDwellMs + 1_000,
    T.enterDwellMs + T.saturateDwellMs + 2_000,
  ]
  for (const t of steps) {
    h.setNow(t)
    h.controller.noteMetrics(101, 'macmini', metrics({ queueDepth: 8, actualFps: 1 }))
    h.controller.noteMetrics(102, 'macmini', metrics({ queueDepth: 8, actualFps: 1 }))
    // Re-noted every tick: a sample older than the TTL stops counting, so a
    // node observed once at t=0 is simply absent by the time this saturates.
    if (withIdleHub) noteIdleHub(h)
    await h.controller.sweep()
  }
  return steps[steps.length - 1] ?? 0
}

/** Keep a quiet node in the picture so the planner has a possible target. */
function noteIdleHub(h: Harness): void {
  h.controller.noteMetrics(104, 'hub', metrics({ phase: 'idle', actualFps: 0 }))
}

describe('NodeStressController', () => {
  it('heartbeats on the FIRST sweep, then hourly — silence must not be ambiguous', async () => {
    const h = await makeHarness()
    h.setMode('observe')
    h.setNow(0)
    h.controller.noteMetrics(101, 'macmini', metrics())
    await h.controller.sweep()
    expect(h.logs).toEqual(['node-stress observe active'])

    // Not again on the next sweep a minute later.
    h.setNow(60_000)
    h.controller.noteMetrics(101, 'macmini', metrics())
    await h.controller.sweep()
    expect(h.logs).toEqual(['node-stress observe active'])

    // An hour on, it says it is still alive.
    h.setNow(60 * 60_000 + 1)
    h.controller.noteMetrics(101, 'macmini', metrics())
    await h.controller.sweep()
    expect(h.logs).toEqual(['node-stress observe active', 'node-stress observe active'])
  })

  it('an unset or unrecognised mode resolves to failover — balancing is automatic', async () => {
    const h = await makeHarness()
    h.setMode('not-a-mode')
    expect(h.controller.mode()).toBe('failover')
  })

  it('off does nothing at all — not even a verdict', async () => {
    const h = await makeHarness()
    h.setMode('off')
    await saturate(h)
    expect(h.logs).toEqual([])
    expect(h.controller.statesView().size).toBe(0)
  })

  it('observe reaches `saturated`, logs it, and moves NOTHING', async () => {
    const h = await makeHarness()
    h.setMode('observe')
    await saturate(h, true)
    expect(h.controller.statesView().get('macmini')).toBe('saturated')
    expect(h.moves).toEqual([])
    expect(h.detaches).toEqual([])
    expect(h.logs).toEqual(['node-stress observe active', 'node is stressed', 'node is saturated'])
  })

  it('failover relocates one camera and says so', async () => {
    const h = await makeHarness()
    await saturate(h, true)
    expect(h.detaches).toEqual([{ nodeId: 'macmini', deviceId: 101 }])
    expect(h.moves).toEqual([{ nodeId: 'hub', deviceId: 101 }])
    expect(h.logs.at(-1)).toBe('node stress failover: camera relocated')
  })

  it('a saturated node with nowhere to go SAYS SO — the branch never drops silently', async () => {
    const h = await makeHarness()
    await saturate(h) // no other node has ever reported metrics
    expect(h.moves).toEqual([])
    expect(h.logs.at(-1)).toBe('node saturated — no failover applied')
  })

  it('a failed relocation is logged and does NOT burn the device cooldown', async () => {
    const h = await makeHarness({ attachFails: true })
    const at = await saturate(h, true)
    expect(h.moves).toEqual([])
    expect(h.logs.at(-1)).toBe('node stress failover: relocation failed')

    // The retry on the next sweep proves the cooldown was not consumed — a
    // flaky attach must not disable failover for that camera for ten minutes.
    h.setNow(at + 15_000)
    noteIdleHub(h)
    h.controller.noteMetrics(101, 'macmini', metrics({ queueDepth: 8, actualFps: 1 }))
    h.controller.noteMetrics(102, 'macmini', metrics({ queueDepth: 8, actualFps: 1 }))
    await h.controller.sweep()
    expect(h.detaches).toEqual([
      { nodeId: 'macmini', deviceId: 101 },
      { nodeId: 'macmini', deviceId: 101 },
    ])
  })

  it('a stale sample stops counting toward its node', async () => {
    const h = await makeHarness()
    h.setMode('observe')
    h.setNow(0)
    h.controller.noteMetrics(101, 'macmini', metrics({ queueDepth: 8 }))
    expect(h.controller.buildInputs(0)[0]?.signals.score).toBe(1)
    // Three sweeps later the observation is no longer about NOW.
    expect(h.controller.buildInputs(60_000)).toEqual([])
  })

  it('forgetDevice drops a removed camera immediately', async () => {
    const h = await makeHarness()
    h.controller.noteMetrics(101, 'macmini', metrics({ queueDepth: 8 }))
    h.controller.forgetDevice(101)
    expect(h.controller.buildInputs(0)).toEqual([])
  })
})

/**
 * The census's third cold-start hole (§1.1 #17): the anti-flap guards are ALL
 * read off the move history, and the history lived in RAM — so every restart
 * handed `failover` a fresh 4-moves/hour budget, cleared every 10-minute device
 * cooldown and lifted every 30-minute return ban. A crash loop is exactly when
 * those guards matter and exactly when they were being reset.
 *
 * Each test below proves the guard SURVIVES a restart against a CONTROL that
 * proves the same guard still opens when it should — so none of them can pass
 * by simply never moving anything.
 */
describe('NodeStressController — the failover budget survives a restart', () => {
  it('an applied move is durable, and a fresh controller over the same records reads it', async () => {
    const records = await makeOrchestratorRecords()
    const first = await makeHarness({ records })
    await saturate(first, true)
    expect(first.moves).toEqual([{ nodeId: 'hub', deviceId: 101 }])
    await Promise.resolve()
    // The move is in the records engine.
    expect(records.tables.get('node-stress-moves')?.size).toBe(1)

    // A fresh controller over the SAME records IS the restart.
    const after = await makeHarness({ records })
    await after.controller.hydrate()
    expect(after.controller.historyView()).toEqual([
      { deviceId: 101, fromNodeId: 'macmini', at: expect.any(Number) },
    ])
  })

  it('THE HOLE: the 10-minute device cooldown is NOT cleared by a restart', async () => {
    const records = await makeOrchestratorRecords()
    const first = await makeHarness({ records })
    const movedAt = await saturate(first, true)
    await Promise.resolve()

    // Restart, five minutes later — inside the 10-minute cooldown.
    const after = await makeHarness({ records })
    await after.controller.hydrate()
    // ONE candidate, so its cooldown is the only thing that can hold the move.
    await drive(after, movedAt + 5 * 60_000, [101])
    expect(after.moves).toEqual([])
    expect(after.logs.at(-1)).toBe('node saturated — no failover applied')

    // CONTROL: the same records, read an hour later, DOES move it — so the
    // assertion above is the cooldown holding, not the harness being inert.
    const later = await makeHarness({ records })
    await later.controller.hydrate()
    await drive(later, movedAt + 11 * 60_000, [101])
    expect(later.moves).toEqual([{ nodeId: 'hub', deviceId: 101 }])
  })

  it('THE HOLE: a spent 4-moves/hour budget is NOT refunded by a restart', async () => {
    const records = await makeOrchestratorRecords()
    // Four moves already spent in this hour, by four different cameras (so no
    // per-device cooldown is what holds the fifth).
    const spentAt = 1_000
    for (const deviceId of [901, 902, 903, 904]) {
      records.seed('node-stress-moves', {
        id: `${deviceId}:${spentAt}`,
        at: spentAt,
        data: { deviceId, fromNodeId: 'macmini', at: spentAt },
      })
    }

    const after = await makeHarness({ records })
    await after.controller.hydrate()
    expect(after.controller.historyView()).toHaveLength(4)
    await drive(after, 10 * 60_000, [101])
    expect(after.moves).toEqual([])
    expect(after.logs.at(-1)).toBe('node saturated — no failover applied')

    // CONTROL: the same records, read an hour later, has a budget again.
    const later = await makeHarness({ records })
    await later.controller.hydrate()
    await drive(later, spentAt + 61 * 60_000, [101])
    expect(later.moves).toEqual([{ nodeId: 'hub', deviceId: 101 }])
  })

  it('a load that fails leaves the budget EMPTY and says so — never a silent refund', async () => {
    const base = await makeOrchestratorRecords()
    // Override the kind's query to throw.
    const brokenKind = {
      ...base.records.kind(orchestratorRecordKinds['node-stress-moves']),
      query: async () => {
        throw new Error('records engine unreachable')
      },
    }
    const broken = new NodeStressMoveLedger({
      kind: brokenKind,
      logger: makeSilentLoggerLocal(),
    })
    expect(await broken.load()).toBe(0)
    expect(broken.entries()).toEqual([])
  })

  it('pruneOlderThan drops moves no guard can read, and keeps the ones that count', async () => {
    const records = await makeOrchestratorRecords()
    const kind = records.records.kind(orchestratorRecordKinds['node-stress-moves'])
    const ledger = new NodeStressMoveLedger({ kind, logger: makeSilentLoggerLocal() })
    ledger.record({ deviceId: 1, fromNodeId: 'a', at: 0 })
    ledger.record({ deviceId: 2, fromNodeId: 'a', at: 10_000_000 })
    await Promise.resolve()
    expect(await ledger.pruneOlderThan(5_000_000)).toBe(1)
    expect(ledger.entries().map((e) => e.deviceId)).toEqual([2])
    expect(records.tables.get('node-stress-moves')?.size).toBe(1)
  })
})

/** Saturate `macmini` at a fixed wall-clock instant, with a quiet target node.
 *  `deviceIds` is the candidate set — narrow it to isolate ONE guard. */
async function drive(
  h: Harness,
  at: number,
  deviceIds: readonly number[] = [101, 102],
): Promise<void> {
  const steps = [
    at,
    at + 10_000,
    at + T.enterDwellMs,
    at + T.enterDwellMs + 1_000,
    at + T.enterDwellMs + T.saturateDwellMs + 2_000,
  ]
  for (const t of steps) {
    h.setNow(t)
    for (const deviceId of deviceIds) {
      h.controller.noteMetrics(deviceId, 'macmini', metrics({ queueDepth: 8, actualFps: 1 }))
    }
    noteIdleHub(h)
    await h.controller.sweep()
  }
}

function makeSilentLoggerLocal(): IScopedLogger {
  const noop = (): void => {}
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}
