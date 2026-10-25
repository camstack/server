/**
 * D791 — the runner's run host: answers at once, one run per node, stops at
 * the deadline on its own, keeps finished cells, and deletes only the
 * candidate models the run itself downloaded.
 */
import { describe, expect, it, vi } from 'vitest'
import { VirtualClock } from '../../capacity/__tests__/virtual-clock.js'
import { NodeBenchHost, type NodeBenchHostDeps } from '../node-bench-host.js'

function host(over: Partial<NodeBenchHostDeps> = {}, clock = new VirtualClock()) {
  let installed = new Set(['yolov9s-640/openvino'])
  const deleted: string[] = []
  const deps: NodeBenchHostDeps = {
    nodeId: 'mac',
    loadFrames: async () => ({
      frames: [{ data: new Uint8Array([1]), width: 1, height: 1 }],
      clip: { id: 'reference-images', revision: null, frames: 1, width: 1, height: 1 },
    }),
    dispatch: async () => {
      // The first call of a candidate "downloads" it.
      installed = new Set([...installed, 'yolov9m-640/openvino'])
      return { shed: false, detections: 1, inferMs: 1, predictMs: 1, stepsRan: [] }
    },
    pipelineSteps: async (m) => [{ addonId: 'object-detection', modelId: m, enabled: true }],
    fingerprint: async () => ({
      pipelineVersion: null,
      cpuModel: null,
      ramGb: null,
      os: null,
      pools: {},
    }),
    installedDetectorModels: async () => installed,
    deleteDetectorModel: async (key) => {
      deleted.push(key)
    },
    activeCameraIds: () => [],
    startStallSampler: () => ({
      snapshot: () => ({ count: 0, maxMs: 0, gcMs: 0, syncCount: 0 }),
      stop: () => undefined,
    }),
    sampleSystem: () => ({ cpuPct: 10, ramFreePct: 60 }),
    log: () => undefined,
    now: clock.now,
    sleepUntil: clock.sleepUntil,
    ...over,
  }
  return { h: new NodeBenchHost(deps), clock, deleted }
}

const INPUT = {
  runId: 'r1',
  devices: [{ deviceKey: 'openvino:npu', modelIds: ['yolov9m-640'] }],
  phases: ['device' as const],
  fpsPerStream: 10,
  deadlineAtMs: 10 * 60_000,
  settleSec: 0,
  measureSec: 2,
}

describe('NodeBenchHost', () => {
  it('answers at once, measures, and deletes only what the run downloaded', async () => {
    const { h, clock, deleted } = host()
    expect(h.start(INPUT)).toEqual({ accepted: true, runId: 'r1' })
    expect(h.status('r1')?.state).toBe('running')
    await clock.run(5 * 60_000)
    await vi.waitFor(() => expect(h.status('r1')?.state).toBe('done'))
    expect(h.status('r1')?.cells).toHaveLength(1)
    expect(deleted).toEqual(['yolov9m-640/openvino'])
    expect(h.status('r1')?.deletedModels).toEqual(['yolov9m-640/openvino'])
  })

  it('keeps downloaded models when told to', async () => {
    const { h, clock, deleted } = host()
    h.start({ ...INPUT, keepDownloadedModels: true })
    await clock.run(5 * 60_000)
    await vi.waitFor(() => expect(h.status('r1')?.state).toBe('done'))
    expect(deleted).toEqual([])
  })

  it('one run per node', async () => {
    const { h } = host()
    h.start(INPUT)
    expect(() => h.start({ ...INPUT, runId: 'r2' })).toThrow(/one at a time/)
    // the same run id again is idempotent
    expect(h.start(INPUT)).toEqual({ accepted: true, runId: 'r1' })
  })

  it('stops itself at the deadline, whatever the hub does', async () => {
    const { h, clock } = host()
    h.start({ ...INPUT, deadlineAtMs: 1000, devices: [{ deviceKey: 'x', modelIds: ['a', 'b'] }] })
    await clock.run(5 * 60_000)
    await vi.waitFor(() => expect(h.status('r1')?.state).toBe('aborted'))
  })

  it('a run that cannot load frames fails with the reason', async () => {
    const { h } = host({ loadFrames: async () => Promise.reject(new Error('no frames')) })
    h.start(INPUT)
    await vi.waitFor(() => expect(h.status('r1')?.state).toBe('failed'))
    expect(h.status('r1')?.error).toBe('no frames')
  })

  it('an unknown run reads null (a restarted runner)', () => {
    expect(host().h.status('nope')).toBeNull()
  })
})
