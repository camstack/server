/**
 * D666 — the pipeline runner's OWN wiring of the decode-worker kill.
 *
 * `decode-worker-shutdown-kill.spec.ts` proves the pieces on a real process
 * tree, through a fixture. It could not see this class: with both call sites
 * removed — the kill in `onShutdown` and the registration at the fork — the
 * whole package stayed green (review M1). These tests drive the real addon.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForkDecodeWorkerDeps } from '../../session-decode/fork-decode-worker.js'
import type { DecodeWorkerFork } from '../../session-decode/live-decode-workers.js'
import type { ForkedChildLike } from '../../session-decode/session-decode-coordinator.js'
import type { VideoFrameSource } from '../../session-decode/video-frame-generator.js'

const forkSpy = vi.fn<DecodeWorkerFork>()

vi.mock('../../session-decode/fork-decode-worker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-decode/fork-decode-worker.js')>()
  return {
    ...actual,
    forkDecodeWorker: (source: VideoFrameSource, deps?: ForkDecodeWorkerDeps): ForkedChildLike =>
      forkSpy(source, deps ?? {}),
  }
})

const { default: PipelineRunnerAddon } = await import('../index.js')

const SOURCE: VideoFrameSource = { restreamUrl: 'rtsp://x/1', deviceId: 101, codec: 'h264' }
const CHILD: ForkedChildLike = { send: () => undefined, on: () => undefined, kill: () => undefined }

describe('pipeline runner — decode workers die with the addon (D666)', () => {
  let exitListenersBefore = 0

  beforeEach(() => {
    forkSpy.mockReset()
    forkSpy.mockReturnValue(CHILD)
    exitListenersBefore = process.listenerCount('exit')
  })

  afterEach(async () => {
    // The exit hook is dropped at shutdown: nothing leaks onto the test process
    // — checked BEFORE the safety-net shutdown below, which would mask it.
    const leaked = process.listenerCount('exit') - exitListenersBefore
    for (const addon of addons.splice(0)) await addon.shutdown()
    expect(leaked).toBe(0)
  })

  /** Every addon a test forks through; shut down after each test either way (review N2). */
  const addons: InstanceType<typeof PipelineRunnerAddon>[] = []
  function newAddon(): InstanceType<typeof PipelineRunnerAddon> {
    const addon = new PipelineRunnerAddon()
    addons.push(addon)
    return addon
  }

  it('every fork is registered, and the shutdown SIGKILLs it', async () => {
    const addon = newAddon()
    // Bracket access: the fork is a private field of the addon, reached here
    // exactly as each spawn site reaches it.
    addon['forkDecodeWorkerWithLease'](SOURCE)
    const deps = forkSpy.mock.calls[0]?.[1]
    expect(deps?.liveWorkers).toBeDefined()
    expect(deps?.costRegistry).toBeDefined()

    const killNow = vi.fn()
    deps?.liveWorkers?.add({ deviceId: 101, pid: 4242, killNow })
    await addon.shutdown()
    expect(killNow).toHaveBeenCalledTimes(1)
  })

  it('a fork after shutdown began is killed at once', async () => {
    const addon = newAddon()
    await addon.shutdown()
    addon['forkDecodeWorkerWithLease'](SOURCE)
    const killNow = vi.fn()
    forkSpy.mock.calls[0]?.[1].liveWorkers?.add({ deviceId: 101, pid: 4243, killNow })
    expect(killNow).toHaveBeenCalledTimes(1)
  })
})
