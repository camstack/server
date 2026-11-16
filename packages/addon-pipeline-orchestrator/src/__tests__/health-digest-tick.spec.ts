/**
 * The 5-minute health digest tick: reads only in-memory sources, keeps a
 * bounded history, and logs what it cost and what changed.
 */
import { describe, expect, it } from 'vitest'
import type { CameraMetrics, LogExtras } from '@camstack/types'
import {
  CameraMetricsMirror,
  HealthDigestTick,
  type HealthTickDeps,
} from '../health-digest-tick.js'

interface LogLine {
  readonly level: 'info' | 'warn' | 'debug'
  readonly msg: string
  readonly tags?: LogExtras['tags']
  readonly meta?: LogExtras['meta']
}

function makeLogger(lines: LogLine[]): HealthTickDeps['logger'] {
  const at =
    (level: LogLine['level']) =>
    (msg: string, ctx?: LogExtras): void => {
      lines.push({ level, msg, ...ctx })
    }
  return { info: at('info'), warn: at('warn'), debug: at('debug') }
}

const METRICS: CameraMetrics = {
  detectionMode: 'always-on',
  configuredFps: 10,
  actualFps: 4,
  queueDepth: 0,
  avgInferenceTimeMs: 400,
  droppedFrames: 0,
  phase: 'active',
}

function deps(over: Partial<HealthTickDeps> = {}): { d: HealthTickDeps; lines: LogLine[] } {
  const lines: LogLine[] = []
  const mirror = new CameraMetricsMirror()
  mirror.note(5, METRICS, 1000)
  let clock = 1000
  const d: HealthTickDeps = {
    now: () => (clock += 7),
    readMotion: () => [],
    readMetrics: () => mirror.view(),
    readPlacement: () => [],
    readUnusableDevices: () => [],
    logger: makeLogger(lines),
    ...over,
  }
  return { d, lines }
}

describe('CameraMetricsMirror', () => {
  it('keeps the latest sample per camera with its arrival time and forgets on request', () => {
    const m = new CameraMetricsMirror()
    m.note(1, METRICS, 10)
    m.note(1, { ...METRICS, actualFps: 9 }, 20)
    expect(m.view().get(1)).toMatchObject({ actualFps: 9, lastSeen: 20, phase: 'active' })
    m.forget(1)
    expect(m.view().size).toBe(0)
  })
})

describe('HealthDigestTick', () => {
  it('builds a digest from the in-memory reads, keeps it, and logs cost and call count', () => {
    const { d, lines } = deps()
    const tick = new HealthDigestTick(d)
    const digest = tick.run()
    expect(tick.latest()).toEqual(digest)
    expect(digest.findings.map((f) => f.kind)).toEqual(['inference-too-slow'])
    const summary = lines.find((l) => l.msg === 'health digest: tick')
    expect(summary?.meta).toMatchObject({ calls: 4, findings: 1, camerasSeen: 1 })
    expect(typeof summary?.meta?.['tickMs']).toBe('number')
  })

  it('a camera finding is logged once with the deviceId tag, and its clearing is logged', () => {
    const { d, lines } = deps()
    const mirror = new CameraMetricsMirror()
    mirror.note(5, METRICS, 1000)
    const tick = new HealthDigestTick({ ...d, readMetrics: () => mirror.view() })
    tick.run()
    tick.run()
    const raised = lines.filter((l) => l.msg === 'health digest: finding raised')
    expect(raised).toHaveLength(1)
    expect(raised[0]?.tags).toEqual({ deviceId: 5 })
    mirror.note(5, { ...METRICS, avgInferenceTimeMs: 20 }, 1100)
    tick.run()
    const cleared = lines.filter((l) => l.msg === 'health digest: finding cleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]?.tags).toEqual({ deviceId: 5 })
  })

  it('a throwing motion or metrics reader yields null sources, a null camera count and is counted unreadable', () => {
    const { d, lines } = deps({
      readMotion: () => {
        throw new Error('boom')
      },
    })
    const digest = new HealthDigestTick(d).run()
    expect(digest.sources.find((s) => s.source === 'motion')?.entries).toBeNull()
    expect(digest.camerasSeen).toBeNull()
    const summary = lines.find((l) => l.msg === 'health digest: tick')
    expect(summary?.meta).toMatchObject({ unreadableSources: 1 })
  })

  it('droppedFrames is cumulative: only growth since the previous tick is shedding', () => {
    const mirror = new CameraMetricsMirror()
    const { d } = deps({ readMetrics: () => mirror.view() })
    const busy = { ...METRICS, avgInferenceTimeMs: 20, queueDepth: 4 }
    const tick = new HealthDigestTick(d)
    mirror.note(5, { ...busy, droppedFrames: 900 }, 1000)
    expect(tick.run().findings).toEqual([]) // first sample: baseline, unknown
    mirror.note(5, { ...busy, droppedFrames: 900 }, 1100)
    expect(tick.run().findings).toEqual([]) // stale old drops
    mirror.note(5, { ...busy, droppedFrames: 950 }, 1200)
    expect(tick.run().findings.map((f) => f.kind)).toEqual(['frames-shed'])
    tick.forget(5)
    mirror.note(5, { ...busy, droppedFrames: 990 }, 1300)
    expect(tick.run().findings).toEqual([]) // baseline forgotten
  })

  it('a source that throws becomes a null read, never a zero, and the tick still completes', () => {
    const { d, lines } = deps({
      readPlacement: () => {
        throw new Error('boom')
      },
    })
    const digest = new HealthDigestTick(d).run()
    expect(digest.sources.find((s) => s.source === 'placement')?.entries).toBeNull()
    expect(
      lines.some((l) => l.level === 'warn' && l.msg === 'health digest: source unreadable'),
    ).toBe(true)
  })
})
