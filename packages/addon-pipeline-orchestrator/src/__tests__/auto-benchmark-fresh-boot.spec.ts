/**
 * D913 on a FRESH install: the automatic benchmark must start without anyone
 * opening a page or attaching a camera.
 *
 * Dev hub CT200, 2026-10-23: 12 minutes after a fresh boot the scheduler had
 * logged only `attempts restored {devices=0}` — no start, wait or skip. Its
 * `readNodes` served each node's devices from the orchestrator's last device
 * PROBE, and that cache is filled only by a reader that asks (placement, the
 * devices page). With no camera and no operator nothing asked, every node came
 * back with `devices: []`, the plan had zero decisions, and the device-set
 * change path that would have ticked the scheduler never fired because no
 * probe ever ran. A never-probed node is now ASKED for its devices, and the
 * probe's answer ticks the scheduler through the existing set-change path.
 */
import type { IScopedLogger, NodeBenchmarkPlanInput } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type AutoBenchDevice,
  AutoBenchmarkScheduler,
  readAutoBenchNodes,
} from '../node-benchmark/auto-benchmark.js'

const silent: IScopedLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silent,
  withTags: () => silent,
}

describe('auto benchmark on a fresh boot', () => {
  it('a node whose devices were never probed is probed, and the answer starts the run', async () => {
    // The orchestrator's probe cache: empty at boot, filled only by a probe.
    const probeCache = new Map<string, readonly AutoBenchDevice[]>()
    const probesRequested: string[] = []
    const started: NodeBenchmarkPlanInput[] = []
    let probeLanded: Promise<void> = Promise.resolve()

    const scheduler: AutoBenchmarkScheduler = new AutoBenchmarkScheduler({
      logger: silent,
      readNodes: () =>
        readAutoBenchNodes({
          onlineNodeIds: ['hub'],
          liveDevices: (nodeId) => probeCache.get(nodeId),
          requestProbe: (nodeId) => {
            probesRequested.push(nodeId)
            // The node answers a moment later; a changed set ticks the scheduler
            // (the orchestrator's `onLiveDevicesChanged`).
            probeLanded = Promise.resolve().then(async () => {
              probeCache.set(nodeId, [{ key: 'cpu', available: true, exclusion: null }])
              await scheduler.tick(`devices:${nodeId}`)
            })
          },
          camerasOn: () => Promise.resolve(0),
        }),
      benchmarked: async () => new Set<string>(),
      runActive: () => false,
      pickModels: async (_nodeId, keys) => Object.fromEntries(keys.map((k) => [k, 'yolov9t'])),
      start: async (plan) => {
        started.push(plan)
        return { kind: 'started' as const, runId: 'r1' }
      },
      now: () => 5_000_000,
    })

    // The probe answers while the boot look is still running: its nudge must
    // be followed by one more look, not dropped until the next minute's tick.
    await scheduler.tick('boot')
    expect(probesRequested, 'a never-probed node must be ASKED for its devices').toEqual(['hub'])

    await probeLanded
    expect(started, 'the probe answered but no run started').toHaveLength(1)
    expect(started[0]).toMatchObject({
      nodeId: 'hub',
      phases: ['device'],
      devices: [{ deviceKey: 'cpu', modelIds: ['yolov9t'] }],
    })
  })

  it('a node with a known device list is not probed again by the scheduler', async () => {
    const requestProbe = vi.fn()
    const nodes = await readAutoBenchNodes({
      onlineNodeIds: ['hub', 'amd'],
      liveDevices: (nodeId) =>
        nodeId === 'amd' ? [{ key: 'edgetpu:usb', available: true, exclusion: null }] : undefined,
      requestProbe,
      camerasOn: (nodeId) => Promise.resolve(nodeId === 'hub' ? 4 : 0),
    })
    expect(requestProbe).toHaveBeenCalledTimes(1)
    expect(requestProbe).toHaveBeenCalledWith('hub')
    expect(nodes).toEqual([
      { nodeId: 'hub', online: true, camerasOnNode: 4, devices: [] },
      {
        nodeId: 'amd',
        online: true,
        camerasOnNode: 0,
        devices: [{ key: 'edgetpu:usb', available: true, exclusion: null }],
      },
    ])
  })
})
