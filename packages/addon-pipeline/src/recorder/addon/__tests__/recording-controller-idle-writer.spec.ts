/**
 * RecordingController: a writer that is PINNED but produces nothing.
 *
 * The give-up path (recording-controller.spec.ts) only fires when ffmpeg
 * EXITS. On 2026-07-29 the opposite happened: after a deploy the writers on
 * 104 + 102 pinned the broker and then hung — process alive, no exit, no
 * error, no retry — and ~68 minutes of recording were lost. `evaluateDevice`
 * short-circuits at "already recording — converged", so nothing ever noticed.
 *
 * A supervisor that reacts only to termination cannot see silence. These tests
 * pin the missing half: no finalized segment within the idle bound → say so
 * (with the deviceId tag) and run the same detach + re-evaluate recovery.
 */

import type { RecordingConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { specRoot } from './spec-root.js'
import { RecordingController, type RecordingControllerDeps } from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'

/** One scratch root per RUN, not one shared path per runner. See `./spec-root.ts`. */
const SPEC_ROOT = specRoot('rec-idle-writer-spec')

interface FakeProc {
  kill: ReturnType<typeof vi.fn>
  on: (ev: string, cb: (...a: unknown[]) => void) => void
  stderr: { on: () => void }
  fireExit: (code?: number) => void
}

function makeFakeProc(): FakeProc {
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  return {
    kill: vi.fn(),
    on: (ev, cb) => {
      handlers[ev] = cb
    },
    stderr: { on: () => {} },
    fireExit: (code = 1) => handlers.exit?.(code),
  }
}

interface CapturedWarn {
  readonly message: string
  readonly deviceId?: number
  readonly meta?: Record<string, unknown>
}

const CONTINUOUS_CONFIG: RecordingConfig = {
  enabled: true,
  bands: [{ mode: 'continuous', days: [], start: '00:00', end: '00:00' }],
}

interface Harness {
  controller: RecordingController
  procs: FakeProc[]
  getStreamWithCodec: ReturnType<typeof vi.fn>
  releaseStreamWithCodec: ReturnType<typeof vi.fn>
  warns: CapturedWarn[]
  now: () => number
  advanceClock: (ms: number) => void
}

function makeHarness(opts: { segmentSeconds?: number } = {}): Harness {
  const procs: FakeProc[] = []
  const spawn = vi.fn(() => {
    const p = makeFakeProc()
    procs.push(p)
    return p
  })

  let acquireSeq = 0
  const getStreamWithCodec = vi.fn(async () => ({
    url: 'rtsp://127.0.0.1:8554/cam99-sub',
    videoCodec: 'H265' as const,
    audioCodec: 'aac' as const,
    resolution: { width: 1280, height: 720 },
    transcoded: false,
    encoder: 'copy',
    pipelineKey: `pk-${++acquireSeq}`,
  }))
  const releaseStreamWithCodec = vi.fn(async () => ({ released: true, refcount: 0 }))

  const warns: CapturedWarn[] = []
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(
      (message: string, o?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> }) => {
        const deviceId = o?.tags?.['deviceId']
        warns.push({
          message,
          ...(typeof deviceId === 'number' ? { deviceId } : {}),
          ...(o?.meta ? { meta: o.meta } : {}),
        })
      },
    ),
    child: () => logger,
    withTags: () => logger,
  } as never

  const api = {
    streamBroker: {
      getStreamWithCodec: { mutate: getStreamWithCodec },
      releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      listAllProfileSlots: {
        query: async () => [
          { deviceId: 99, profile: 'sub', camStreamId: 'native:sub', status: 'streaming' },
        ],
      },
    },
  } as never

  // The controller reads wall clock through `deps.now` — drive it explicitly so
  // the idle bound is exercised without waiting minutes of real time.
  let clock = 1_800_000_000_000
  const now = (): number => clock

  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    api,
    logger,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: { onFinalized: vi.fn(async () => null) } as never,
    loadConfig: async () => CONTINUOUS_CONFIG,
    enabledDeviceIds: async () => [99],
    locations: () => [
      recordingsLocationOfMode(
        { id: 'recordings:default', type: 'recordings', root: SPEC_ROOT },
        'active',
      ),
    ],
    spawn: spawn as never,
    segmentSeconds: opts.segmentSeconds ?? 4,
    watchIntervalMs: 3_600_000,
    onBrokerReady: () => () => {},
    brokerCall: (fn) => fn(),
    now,
  }

  return {
    controller: new RecordingController(deps),
    procs,
    getStreamWithCodec,
    releaseStreamWithCodec,
    warns,
    now,
    advanceClock: (ms: number) => {
      clock += ms
    },
  }
}

describe('RecordingController — a pinned writer that produces nothing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says so, with the deviceId tag, instead of staying silent', async () => {
    const h = makeHarness()
    await h.controller.start()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    // ffmpeg never exits and never finalizes a segment: five minutes of nothing.
    h.advanceClock(5 * 60_000)
    await vi.advanceTimersByTimeAsync(60_000)

    const idle = h.warns.find((w) => /no segment/i.test(w.message))
    expect(idle).toBeDefined()
    expect(idle!.deviceId).toBe(99)

    await h.controller.stop()
  })

  it('re-pins the source so recording actually resumes', async () => {
    const h = makeHarness()
    await h.controller.start()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    h.advanceClock(5 * 60_000)
    await vi.advanceTimersByTimeAsync(60_000)

    // Recovery = detach (release the lease) + re-evaluate → a SECOND acquire.
    // The re-evaluate is a promise chain that can still be in flight after
    // the timer advance on a loaded CI runner, so wait for its outcome
    // (vi.waitFor advances the fake clock between checks) instead of
    // asserting on one microtask flush.
    await vi.waitFor(() => {
      expect(h.releaseStreamWithCodec).toHaveBeenCalled()
      expect(h.getStreamWithCodec.mock.calls.length).toBeGreaterThan(1)
    })

    await h.controller.stop()
  })

  it('does not fire while the writer is still within its grace window', async () => {
    const h = makeHarness()
    await h.controller.start()

    // One tick's worth of time, far below the idle bound.
    h.advanceClock(30_000)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(h.warns.some((w) => /no segment/i.test(w.message))).toBe(false)
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
  })

  it('scales the bound with segmentSeconds so long segments are not false positives', async () => {
    // 120 s segments: at 5 minutes of silence a fixed 90 s bound would have
    // fired after the FIRST segment was merely still being written.
    const h = makeHarness({ segmentSeconds: 120 })
    await h.controller.start()

    h.advanceClock(4 * 60_000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(h.warns.some((w) => /no segment/i.test(w.message))).toBe(false)

    await h.controller.stop()
  })
})
