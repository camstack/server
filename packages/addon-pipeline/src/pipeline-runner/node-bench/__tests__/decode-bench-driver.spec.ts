/**
 * D1078 — the decode measurement on a simulated node: a profile holds while
 * every stream keeps the profile frame rate inside the CPU and RAM limits, the
 * cell names the limit that stopped the ramp and the decoder that carried it,
 * a profile that cannot be offered is skipped with its reason (no cell), and a
 * ramp cut short yields no cell.
 */
import {
  type NodeBenchDecodeCell,
  NodeBenchRunnerInputSchema,
  type NodeDecodeProfile,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { VirtualClock } from '../../capacity/__tests__/virtual-clock.js'
import {
  DecodeBenchDriver,
  type DecodeRig,
  type DecodeRigOutcome,
  type DecodeStreamWindow,
} from '../decode-bench-driver.js'

const UHD: NodeDecodeProfile = {
  width: 3840,
  height: 2160,
  fps: 15,
  codec: 'h265',
}
const FHD: NodeDecodeProfile = {
  width: 1920,
  height: 1080,
  fps: 15,
  codec: 'h264',
}

interface SimNode {
  /** Frames per second the node decodes in total for this profile. */
  readonly totalFps?: number
  readonly cpuPerStream?: number
  readonly ramFreePct?: number
  /** Streams the hardware decoder accepts; the rest decode in software. */
  readonly hardwareSessions?: number
  /** A stream beyond this count never delivers a first frame. */
  readonly startable?: number
  /** What the rig answers for a stream it would not start (default: no first frame). */
  readonly refusal?: string
  readonly skip?: string
  readonly stopAtLoad?: number
  readonly ageMs?: number
}

async function simulate(
  node: SimNode,
  profiles: readonly NodeDecodeProfile[] = [UHD],
): Promise<{
  cells: NodeBenchDecodeCell[]
  skipped: string[]
  closed: number
  maxOpened: number
}> {
  const clock = new VirtualClock()
  const cells: NodeBenchDecodeCell[] = []
  const skipped: string[] = []
  let closed = 0
  let maxOpened = 0
  let load = 0
  const input = NodeBenchRunnerInputSchema.parse({
    runId: 'r',
    devices: [{ deviceKey: 'cpu', modelIds: ['m'] }],
    phases: ['decode'],
    decodeProfiles: [...profiles],
    fpsPerStream: 5,
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
    settleSec: 1,
    measureSec: 10,
  })
  const openRig = async (profile: NodeDecodeProfile): Promise<DecodeRigOutcome> => {
    if (node.skip !== undefined) return { kind: 'skipped', reason: node.skip }
    let streams = 0
    let windowStart = 0
    const rig: DecodeRig = {
      scaleTo: async (count) => {
        streams = count
        load = count
        maxOpened = Math.max(maxOpened, count)
        await clock.sleepUntil(clock.now() + 500)
        return node.startable !== undefined && count > node.startable
          ? {
              ready: false,
              reason: node.refusal ?? 'unresolved: no first frame',
            }
          : { ready: true, reason: null }
      },
      beginWindow: () => {
        windowStart = clock.now()
      },
      endWindow: (): readonly DecodeStreamWindow[] => {
        const sec = (clock.now() - windowStart) / 1000
        const each = Math.min(profile.fps, (node.totalFps ?? 1e9) / streams)
        return Array.from({ length: streams }, (_, i) => ({
          frames: Math.round(each * sec),
          ageP95Ms: node.ageMs ?? 20,
          errors: 0,
          decoder: i < (node.hardwareSessions ?? 1e9) ? 'vaapi' : 'software',
        }))
      },
      motionRan: () => true,
      close: async () => {
        closed += 1
      },
    }
    return { kind: 'ready', rig }
  }
  const driver = new DecodeBenchDriver({
    input,
    openRig,
    now: clock.now,
    sleepUntil: clock.sleepUntil,
    shouldStop: () => node.stopAtLoad !== undefined && load >= node.stopAtLoad,
    stallSnapshot: () => ({ count: 0, maxMs: 0, gcMs: 0, syncCount: 0 }),
    sampleSystem: () => ({
      cpuPct: load * (node.cpuPerStream ?? 0),
      ramFreePct: node.ramFreePct ?? 50,
    }),
    onProgress: () => undefined,
    onCell: (cell) => cells.push(cell),
    onSkipped: (reason) => skipped.push(reason),
  })
  const done = driver.run()
  await clock.run(60 * 60_000)
  await done
  return { cells, skipped, closed, maxOpened }
}

describe('DecodeBenchDriver', () => {
  it('the last load at which EVERY stream kept the profile rate is the capacity', async () => {
    // 100 fps of 4K decode in total: 6 streams get 15 each, 8 get 12.5 (< 13.5).
    const { cells, closed } = await simulate({ totalFps: 100 })
    expect(cells).toHaveLength(1)
    const cell = cells[0]
    expect(cell).toMatchObject({
      phase: 'decode',
      profile: UHD,
      maxStreams: 6,
      limitedBy: 'fps',
      hardware: true,
      decoder: 'vaapi',
      motion: true,
    })
    expect(cell?.ramp.map((s) => [s.load, s.pass])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [6, true],
      [8, false],
    ])
    expect(cell?.ramp.at(-1)?.minFps).toBe(12.5)
    expect(closed).toBe(1)
  })

  it('a rate within the tolerance holds (13.5 of 15)', async () => {
    // 108 fps: 8 streams get exactly 13.5 = 90 % of 15.
    const { cells } = await simulate({ totalFps: 108 })
    expect(cells[0]?.maxStreams).toBe(8)
  })

  it('stops at the CPU limit although the streams still keep their rate', async () => {
    const { cells } = await simulate({ cpuPerStream: 20 })
    expect(cells[0]).toMatchObject({ maxStreams: 4, limitedBy: 'cpu' })
    expect(cells[0]?.ramp.at(-1)?.cpuPct).toBe(120)
  })

  it('a first step that fails on free RAM measured nothing: no cell, the profile is skipped with the reason', async () => {
    const { cells, skipped } = await simulate({ ramFreePct: 10 })
    expect(cells).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatch(/^decode .*: ram free 10%/)
  })

  it('a first stream that never delivers a frame is skipped, never a measured zero', async () => {
    const { cells, skipped } = await simulate({ startable: 0 })
    expect(cells).toEqual([])
    expect(skipped[0]).toMatch(/unresolved/)
  })

  it('a first step cut by CPU contention is skipped, never a measured zero', async () => {
    const { cells, skipped } = await simulate({ cpuPerStream: 200 })
    expect(cells).toEqual([])
    expect(skipped[0]).toMatch(/cpu/)
  })

  it('a node that really cannot decode one stream at camera rate stores a measured zero', async () => {
    const { cells, skipped } = await simulate({ totalFps: 5 })
    expect(skipped).toEqual([])
    expect(cells[0]).toMatchObject({ maxStreams: 0, limitedBy: 'fps' })
  })

  it('frames that arrive late fail the step although the rate holds', async () => {
    const { cells } = await simulate({ ageMs: 1500 })
    expect(cells[0]).toMatchObject({ maxStreams: 0, limitedBy: 'p95' })
    expect(cells[0]?.ramp).toHaveLength(1)
  })

  it('a stream that never starts ends the ramp as an error, with no rate invented', async () => {
    const { cells } = await simulate({ startable: 2 })
    expect(cells[0]).toMatchObject({ maxStreams: 2, limitedBy: 'errors' })
    expect(cells[0]?.ramp.at(-1)).toMatchObject({
      load: 3,
      pass: false,
      minFps: null,
    })
  })

  it('a stream refused for free RAM before its fork stops the ramp on RAM, not as an error', async () => {
    const { cells } = await simulate({
      startable: 3,
      refusal: 'ram free 9% < 15%',
    })
    expect(cells[0]?.maxStreams).toBe(3)
    expect(cells[0]?.limitedBy).toBe('ram')
  })

  it('names every decoder the held streams ran on, and hardware only when all did', async () => {
    const { cells } = await simulate({ totalFps: 100, hardwareSessions: 2 })
    expect(cells[0]).toMatchObject({
      maxStreams: 6,
      hardware: false,
      decoder: 'software+vaapi',
    })
  })

  it('a ramp that never failed says so', async () => {
    const { cells, maxOpened } = await simulate({})
    expect(cells[0]).toMatchObject({
      limitedBy: 'none',
      maxStreams: maxOpened,
    })
  })

  it('a profile that cannot be offered is skipped with its reason and stores NO cell', async () => {
    const { cells, skipped } = await simulate({ skip: 'no libx265 encoder' })
    expect(cells).toEqual([])
    expect(skipped).toEqual(['decode 2160p-h265-15: no libx265 encoder'])
  })

  it('a ramp cut short stores no cell and still closes its streams', async () => {
    const { cells, closed } = await simulate({ stopAtLoad: 3 })
    expect(cells).toEqual([])
    expect(closed).toBe(1)
  })

  it('measures every profile, each with its own streams', async () => {
    const { cells, closed } = await simulate({ totalFps: 100 }, [UHD, FHD])
    expect(cells.map((c) => c.profile)).toEqual([UHD, FHD])
    expect(closed).toBe(2)
  })
})
