/**
 * What the placement pass costs when a dependency stops answering.
 *
 * MEASURED, 2026-08-25: the pass that logged `durationMs: 181056` spent its
 * FIRST 59 952 ms inside `enabledDeviceIds()` and then logged
 * `could not enumerate persisted devices`. That read is a cross-process call to
 * `hub/sqlite-settings`; nothing bounded it, so it fell through to the 60 s UDS
 * default — twice the pass's whole budget, spent before the pass had looked at
 * a single storage location. And because `startPeriodicPass` skips a fire while
 * a run is in flight, the ticks behind it were cancelled, not delayed.
 *
 * So: the head of the pass is bounded, the degraded pass still covers the ACTIVE
 * devices (the pre-existing, already-logged fallback), and a pass that runs long
 * says WHICH HALF was slow instead of leaving it to be correlated by hand.
 */
import type { RecordingConfig } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { specRoot } from './spec-root.js'

/** One scratch root per RUN, not one shared path per runner. See `./spec-root.ts`. */
const SPEC_ROOT = specRoot('rec-placement-pass-spec')
import {
  PLACEMENT_TICK_MS,
  RecordingController,
  type RecordingControllerDeps,
} from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'

/** A logger whose four levels are spies the specs read back, typed as the port. */
interface LoggerSpy extends IScopedLogger {
  readonly info: Mock<IScopedLogger['info']>
  readonly warn: Mock<IScopedLogger['warn']>
  readonly error: Mock<IScopedLogger['error']>
  readonly debug: Mock<IScopedLogger['debug']>
}
const loggerMock: LoggerSpy = {
  info: vi.fn<IScopedLogger['info']>(),
  warn: vi.fn<IScopedLogger['warn']>(),
  error: vi.fn<IScopedLogger['error']>(),
  debug: vi.fn<IScopedLogger['debug']>(),
  child: () => loggerMock,
  withTags: () => loggerMock,
}

/** Always-on continuous band: `start === end` + no days ⇒ active at every instant. */
const CONTINUOUS_CONFIG: RecordingConfig = {
  enabled: true,
  bands: [{ mode: 'continuous', days: [], start: '00:00', end: '00:00' }],
}

interface PassHarness {
  readonly controller: RecordingController
  /** Device ids each placement tick was handed. */
  readonly ticks: (readonly number[])[]
  /** Make every SUBSEQUENT `enabledDeviceIds` hang — a frozen settings door.
   *  Armed after `start()` so the harness boots against a healthy store. */
  freezeEnumerate: () => void
}

function makeHarness(): PassHarness {
  const ticks: (readonly number[])[] = []
  let frozen = false
  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    api: {
      streamBroker: {
        getStreamWithCodec: {
          mutate: async () => ({
            url: 'rtsp://127.0.0.1:8554/cam99-sub',
            videoCodec: 'H265' as const,
            audioCodec: 'aac' as const,
            resolution: { width: 1280, height: 720 },
            transcoded: false,
            encoder: 'copy',
            pipelineKey: 'pk-1',
          }),
        },
        releaseStreamWithCodec: { mutate: async () => ({ released: true, refcount: 0 }) },
        listAllProfileSlots: {
          query: async () => [
            { deviceId: 99, profile: 'sub', camStreamId: 'native:sub', status: 'streaming' },
          ],
        },
      },
    } as never,
    logger: loggerMock,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: { onFinalized: async () => null } as never,
    loadConfig: async () => CONTINUOUS_CONFIG,
    enabledDeviceIds: async () => {
      if (frozen) return new Promise<number[]>(() => {})
      return [99]
    },
    locations: () => [
      recordingsLocationOfMode(
        { id: 'recordings:default', type: 'recordings', root: SPEC_ROOT },
        'active',
      ),
    ],
    spawn: (() => ({
      kill: vi.fn(),
      on: () => {},
      stderr: { on: () => {} },
    })) as never,
    segmentSeconds: 4,
    watchIntervalMs: 3_600_000,
    onBrokerReady: () => () => {},
    brokerCall: (fn) => fn(),
    onPlacementTick: async (ids) => {
      ticks.push(ids)
    },
  }
  return {
    controller: new RecordingController(deps),
    ticks,
    freezeEnumerate: () => {
      frozen = true
    },
  }
}

describe('the placement pass bounds the read at its head', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('still recomputes when the settings door never answers', async () => {
    const h = makeHarness()
    await h.controller.start()
    h.freezeEnumerate()

    // One placement tick, then well past the bound but far short of the 60 s
    // UDS default the read used to fall through to.
    await vi.advanceTimersByTimeAsync(PLACEMENT_TICK_MS)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(h.ticks.length).toBeGreaterThan(0)
    await h.controller.stop()
  })

  it('names the degradation instead of silently narrowing its scope', async () => {
    const h = makeHarness()
    await h.controller.start()
    h.freezeEnumerate()
    await vi.advanceTimersByTimeAsync(PLACEMENT_TICK_MS + 10_000)

    const warned = loggerMock.warn.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('could not enumerate'),
    )
    expect(warned).toBe(true)
    await h.controller.stop()
  })

  it('reports the phase breakdown of a long pass', async () => {
    const h = makeHarness()
    await h.controller.start()
    h.freezeEnumerate()
    await vi.advanceTimersByTimeAsync(PLACEMENT_TICK_MS + 10_000)

    const phaseLine = loggerMock.warn.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('phase breakdown'),
    )
    expect(phaseLine).toBeDefined()
    await h.controller.stop()
  })

  it('does not report a phase breakdown for a healthy pass', async () => {
    const h = makeHarness()
    await h.controller.start()
    await vi.advanceTimersByTimeAsync(PLACEMENT_TICK_MS)

    const phaseLine = loggerMock.warn.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('phase breakdown'),
    )
    expect(phaseLine).toBeUndefined()
    await h.controller.stop()
  })
})
