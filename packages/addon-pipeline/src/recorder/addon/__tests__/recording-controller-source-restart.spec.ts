/**
 * RecordingController: a broker source restart recovers the writer AT ONCE.
 *
 * 2026-11-20, Home Hub children 3628 / 3629: the hub cuts the session every
 * 28 min 07 s, the broker re-dials, and the recorder's ffmpeg writer — which
 * reads the broker over a transport that does not announce the cut — noticed
 * only through its idle clock (max(90 s, 3 x segment)): a ~108 s gap each time.
 * The broker now announces the re-dial (`StreamBrokerOnSourceRestart`) and the
 * controller recovers the device's writers straight away.
 */

import type { RecordingConfig } from '@dominevo/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RecordingController,
  SOURCE_RESTART_RECOVERY_MIN_INTERVAL_MS,
  type RecordingControllerDeps,
} from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'
import { specRoot } from './spec-root.js'

const SPEC_ROOT = specRoot('rec-source-restart-spec')

const CONTINUOUS_CONFIG: RecordingConfig = {
  enabled: true,
  bands: [{ mode: 'continuous', days: [], start: '00:00', end: '00:00' }],
}

function makeHarness() {
  const acquires = new Map<number, number>()
  let seq = 0
  const getStreamWithCodec = vi.fn(async (input: { deviceId: number }) => {
    acquires.set(input.deviceId, (acquires.get(input.deviceId) ?? 0) + 1)
    return {
      url: `rtsp://127.0.0.1:8554/cam${input.deviceId}-sub`,
      videoCodec: 'H265' as const,
      audioCodec: 'aac' as const,
      resolution: { width: 1280, height: 720 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: `pk-${++seq}`,
    }
  })
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as never
  const api = {
    streamBroker: {
      getStreamWithCodec: { mutate: getStreamWithCodec },
      releaseStreamWithCodec: { mutate: vi.fn(async () => ({ released: true, refcount: 0 })) },
      listAllProfileSlots: {
        query: async () => [
          { deviceId: 99, profile: 'sub', camStreamId: 'native:sub', status: 'streaming' },
        ],
      },
    },
  } as never
  let clock = 1_800_000_000_000
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
    spawn: vi.fn(() => ({
      kill: vi.fn(),
      on: () => {},
      stderr: { on: () => {} },
    })) as never,
    segmentSeconds: 4,
    watchIntervalMs: 3_600_000,
    onBrokerReady: () => () => {},
    brokerCall: (fn) => fn(),
    now: () => clock,
  }
  return {
    controller: new RecordingController(deps),
    acquiresFor: (id: number) => acquires.get(id) ?? 0,
    advanceClock: (ms: number) => {
      clock += ms
    },
  }
}

async function settle(done: () => boolean, maxTurns = 2_000): Promise<void> {
  for (let i = 0; i < maxTurns && !done(); i++) await vi.advanceTimersByTimeAsync(1)
}

describe('RecordingController.onSourceRestarted', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-pins the device writer immediately, with no idle-bound wait', async () => {
    const h = makeHarness()
    await h.controller.start()
    expect(h.acquiresFor(99)).toBe(1)

    await h.controller.onSourceRestarted(99, 'dial#2')
    await settle(() => h.acquiresFor(99) >= 2)

    // The clock never moved: this is not the idle watchdog.
    expect(h.acquiresFor(99)).toBe(2)
    await h.controller.stop()
  })

  it('keeps the writer across a publisher-refresh re-dial of the SAME url', async () => {
    const h = makeHarness()
    await h.controller.start()
    expect(h.acquiresFor(99)).toBe(1)

    await h.controller.onSourceRestarted(99, 'dial#2', { urlChanged: false, kicked: true })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(h.acquiresFor(99)).toBe(1)
    await h.controller.stop()
  })

  it('still respawns when the url changed, or when the re-dial was not a publisher kick', async () => {
    const h = makeHarness()
    await h.controller.start()
    await h.controller.onSourceRestarted(99, 'dial#2', { urlChanged: true, kicked: true })
    await settle(() => h.acquiresFor(99) >= 2)
    expect(h.acquiresFor(99)).toBe(2)

    h.advanceClock(SOURCE_RESTART_RECOVERY_MIN_INTERVAL_MS + 1)
    await h.controller.onSourceRestarted(99, 'dial#3', { urlChanged: false, kicked: false })
    await settle(() => h.acquiresFor(99) >= 3)
    expect(h.acquiresFor(99)).toBe(3)
    await h.controller.stop()
  })

  it('does not thrash: a second restart inside the minimum interval is ignored', async () => {
    const h = makeHarness()
    await h.controller.start()
    await h.controller.onSourceRestarted(99, 'dial#2')
    await settle(() => h.acquiresFor(99) >= 2)

    await h.controller.onSourceRestarted(99, 'dial#3')
    await vi.advanceTimersByTimeAsync(100)
    expect(h.acquiresFor(99)).toBe(2)

    h.advanceClock(SOURCE_RESTART_RECOVERY_MIN_INTERVAL_MS + 1)
    await h.controller.onSourceRestarted(99, 'dial#4')
    await settle(() => h.acquiresFor(99) >= 3)
    expect(h.acquiresFor(99)).toBe(3)
    await h.controller.stop()
  })

  it('ignores a device that is not recording', async () => {
    const h = makeHarness()
    await h.controller.start()
    await h.controller.onSourceRestarted(12345, 'dial#2')
    await vi.advanceTimersByTimeAsync(100)
    expect(h.acquiresFor(12345)).toBe(0)
    expect(h.acquiresFor(99)).toBe(1)
    await h.controller.stop()
  })
})
