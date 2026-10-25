/**
 * D791 — the node benchmark measurement on a simulated node: the `device`
 * ramp stops where p95 leaves the frame interval, the `pipeline` ramp also
 * stops at the CPU bound, every dispatch reads the next frame, the steps that
 * ran are reported, and a ramp cut short by an abort yields no cell.
 */
import {
  type NodeBenchCell,
  NodeBenchRunnerInputSchema,
  type NodeBenchRunnerInputRaw,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { VirtualClock } from '../../capacity/__tests__/virtual-clock.js'
import {
  type BenchDispatchResult,
  type BenchFrame,
  limitOf,
  NodeBenchDriver,
} from '../node-bench-driver.js'

const FRAMES: BenchFrame[] = [0, 1, 2].map((i) => ({
  data: new Uint8Array([i]),
  width: 1,
  height: 1,
}))

interface SimOptions {
  /** Service time of one call on the simulated single-server device. */
  readonly serviceMs: number
  readonly cpuPerLoad?: number
  readonly stopAfterCells?: number
  readonly input?: Partial<NodeBenchRunnerInputRaw>
}

async function simulate(opts: SimOptions): Promise<{
  cells: NodeBenchCell[]
  framesSeen: number[]
}> {
  const clock = new VirtualClock()
  let busyUntil = 0
  let load = 0
  const cells: NodeBenchCell[] = []
  const framesSeen: number[] = []
  const input = NodeBenchRunnerInputSchema.parse({
    runId: 'r',
    devices: [{ deviceKey: 'npu', modelIds: ['m1'] }],
    phases: ['device'],
    steps: [],
    fpsPerStream: 10,
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
    settleSec: 0,
    measureSec: 2,
    ...opts.input,
  })
  const driver = new NodeBenchDriver({
    input,
    frames: FRAMES,
    dispatch: async ({ frame, plane }): Promise<BenchDispatchResult> => {
      framesSeen.push(frame.data[0] ?? -1)
      const start = Math.max(clock.now(), busyUntil)
      busyUntil = start + opts.serviceMs
      await clock.sleepUntil(busyUntil)
      return {
        shed: false,
        detections: 1,
        inferMs: opts.serviceMs,
        predictMs: opts.serviceMs,
        stepsRan: plane === 'full' ? ['object-detection', 'face-detection'] : ['object-detection'],
      }
    },
    pipelineSteps: async (m) => [{ addonId: 'object-detection', modelId: m, enabled: true }],
    now: clock.now,
    sleepUntil: clock.sleepUntil,
    shouldStop: () => opts.stopAfterCells !== undefined && cells.length >= opts.stopAfterCells,
    stallSnapshot: () => ({ count: 0, maxMs: 0, gcMs: 0, syncCount: 0 }),
    rssMb: () => 100,
    sampleSystem: () => ({ cpuPct: load * (opts.cpuPerLoad ?? 0), ramFreePct: 50 }),
    onProgress: (p) => {
      if (p.load !== null) load = p.load
    },
    onCell: (c) => cells.push(c),
  })
  const done = driver.run()
  await clock.run(10 * 60_000)
  await done
  return { cells, framesSeen }
}

describe('NodeBenchDriver — device measurement', () => {
  it('kMax is the last stream count whose p95 stays inside the frame interval', async () => {
    // 20 ms per call ⇒ 50 fps. At 10 fps per stream: 4 streams (40 fps) pass,
    // 6 (60 fps) queue past the 100 ms interval.
    const { cells } = await simulate({ serviceMs: 20 })
    expect(cells).toHaveLength(1)
    const cell = cells[0]
    expect(cell?.phase).toBe('device')
    if (cell?.phase !== 'device') return
    expect(cell.kMax).toBe(4)
    expect(cell.limitedBy === 'p95' || cell.limitedBy === 'drops').toBe(true)
    expect(cell.p50Ms).toBeCloseTo(20, 0)
    expect(cell.fps).toBeGreaterThanOrEqual(38)
    expect(cell.ramp.map((s) => s.load)).toEqual([1, 2, 4, 6])
  })

  it('every dispatch reads the next frame of the ring', async () => {
    const { framesSeen } = await simulate({ serviceMs: 200 })
    expect(framesSeen.slice(0, 6)).toEqual([0, 1, 2, 0, 1, 2])
  })

  it('a device too slow for one stream reports kMax 0', async () => {
    const { cells } = await simulate({ serviceMs: 150 })
    expect(cells[0]?.phase === 'device' && cells[0].kMax).toBe(0)
  })
})

describe('NodeBenchDriver — pipeline measurement', () => {
  it('stops at the CPU bound and names the steps that ran', async () => {
    const { cells } = await simulate({
      serviceMs: 5,
      cpuPerLoad: 15,
      input: { phases: ['pipeline'], steps: ['face-detection', 'plate-detection'] },
    })
    const cell = cells[0]
    expect(cell?.phase).toBe('pipeline')
    if (cell?.phase !== 'pipeline') return
    // 6 sessions × 15 % = 90 % > 85 %.
    expect(cell.maxSessions).toBe(4)
    expect(cell.limitedBy).toBe('cpu')
    expect(cell.stepsFired).toEqual(['face-detection'])
    expect(cell.ramp.at(-1)?.cpuPct).toBe(90)
  })
})

describe('NodeBenchDriver — stopping', () => {
  it('stops between cells when told to, keeping what it finished', async () => {
    const { cells } = await simulate({
      serviceMs: 200,
      stopAfterCells: 1,
      input: { devices: [{ deviceKey: 'npu', modelIds: ['m1', 'm2', 'm3'] }] },
    })
    expect(cells.map((c) => c.modelId)).toEqual(['m1'])
  })
})

describe('limitOf', () => {
  it('names the first limit in priority order', () => {
    expect(limitOf(['e2e p95 140ms > 100ms', 'cpu 90% > 85%'])).toBe('cpu')
    expect(limitOf(['dropRatio 3.00% > 1.00%'])).toBe('drops')
    expect(limitOf(['errors 2 (0 tolerated)'])).toBe('errors')
    expect(limitOf([])).toBe('none')
  })
})
