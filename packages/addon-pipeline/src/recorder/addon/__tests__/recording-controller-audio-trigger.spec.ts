/**
 * Track 0 — `audioThresholdDbfs` goes from "dead knob" to wired trigger.
 *
 * Before 2026-08-26 the only production call site of `onTrigger` passed
 * `'motion'` (`recorder/addon/index.ts:1239`), e `subscribeEventCapture`
 * exposed only `onMotion`: an `events` band with the audio-ONLY trigger never
 * recorded, without a line (D62 — see `band-decision.ts`,
 * `UNFED_TRIGGER_KEYS`).
 *
 * `RecordingController.onAudioLevel` is the feed: called for every
 * `PipelineAudioInferenceResultPayload` (subscribed in
 * `recorder/addon/index.ts`), it resolves the ACTIVE band at the timestamp of the
 * audio window (same scheme as `postBufferMsFor` for the post-buffer — a
 * device can have different bands with different thresholds, day/night), compares
 * the level with `audioLevelQualifies` (same dBFS unit, no
 * conversion — see `band-decision.ts`) and, if it qualifies, calls
 * `onTrigger(deviceId, 'audio', atMs)` — the SAME entry point `onMotion` uses
 * for `'motion'`, so the rest of the chain (TriggerState, the live gate,
 * the retention gate, the scheduler) does not need to know that this
 * source exists: it was already generic, just never fed.
 *
 * These tests assert the OBSERVABLE effect (the writer attaches),
 * not merely that `onTrigger` was called — a mock of `onTrigger` here
 * would only prove that the test knows the implementation, not that
 * production really records.
 */

import type { RecordingConfig } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { specRoot } from './spec-root.js'
import { RecordingController, type RecordingControllerDeps } from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'

/** One scratch root per RUN, not one shared path per runner. See `./spec-root.ts`. */
const SPEC_ROOT = specRoot('rec-audio-trigger-spec')

interface FakeProc {
  kill: ReturnType<typeof vi.fn>
  on: (ev: string, cb: (...a: unknown[]) => void) => void
  stderr: { on: () => void }
}

function makeFakeProc(): FakeProc {
  return { kill: vi.fn(), on: () => {}, stderr: { on: () => {} } }
}

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

const DEVICE_ID = 99

interface Harness {
  readonly controller: RecordingController
  readonly getStreamWithCodec: ReturnType<typeof vi.fn>
  setConfig(config: RecordingConfig): void
  failNextConfigLoad(): void
}

function makeHarness(initial: RecordingConfig): Harness {
  let config = initial
  let failNextLoad = false
  const spawn = vi.fn(() => makeFakeProc())
  let acquireSeq = 0
  const getStreamWithCodec = vi.fn(async () => ({
    url: 'rtsp://127.0.0.1:8554/cam99-high',
    videoCodec: 'H265' as const,
    audioCodec: 'aac' as const,
    resolution: { width: 1920, height: 1080 },
    transcoded: false,
    encoder: 'copy',
    pipelineKey: `pk-${++acquireSeq}`,
  }))
  const releaseStreamWithCodec = vi.fn(async () => ({ released: true, refcount: 0 }))
  const listAllProfileSlots = vi.fn(async () => [
    { deviceId: DEVICE_ID, profile: 'high', camStreamId: 'native:main', status: 'streaming' },
  ])

  const api = {
    streamBroker: {
      getStreamWithCodec: { mutate: getStreamWithCodec },
      releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      listAllProfileSlots: { query: listAllProfileSlots },
    },
  } as never

  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    api,
    logger: loggerMock,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: { onFinalized: async () => null } as never,
    loadConfig: async () => {
      if (failNextLoad) {
        failNextLoad = false
        throw new Error('config store unavailable')
      }
      return config
    },
    enabledDeviceIds: async () => [DEVICE_ID],
    locations: () => [
      recordingsLocationOfMode(
        { id: 'recordings:default', type: 'recordings', root: SPEC_ROOT },
        'active',
      ),
    ],
    spawn: spawn as never,
    segmentSeconds: 4,
    watchIntervalMs: 3_600_000,
    onBrokerReady: () => () => {},
    brokerCall: (fn) => fn(),
  }

  return {
    controller: new RecordingController(deps),
    getStreamWithCodec,
    setConfig: (next) => {
      config = next
    },
    failNextConfigLoad: () => {
      failNextLoad = true
    },
  }
}

/** An always-covering `events` band that listens ONLY to audio. */
const AUDIO_ONLY_BAND: RecordingConfig = {
  enabled: true,
  bands: [
    {
      mode: 'events',
      days: [],
      start: '00:00',
      end: '00:00',
      triggers: { audioThresholdDbfs: -30 },
      postBufferSec: 30,
    },
  ],
}

/** An always-covering `events` band that listens ONLY to motion — audio must not arm it. */
const MOTION_ONLY_BAND: RecordingConfig = {
  enabled: true,
  bands: [{ mode: 'events', days: [], start: '00:00', end: '00:00', triggers: { motion: true } }],
}

describe('RecordingController.onAudioLevel — the audio trigger, wired', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a LOUD window (dbfs >= threshold) pins the broker source, same as a motion trigger', async () => {
    const h = makeHarness(AUDIO_ONLY_BAND)
    await h.controller.start()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    await h.controller.onAudioLevel(DEVICE_ID, -20, Date.now())
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(h.getStreamWithCodec.mock.calls[0]![0]).toMatchObject({ deviceId: DEVICE_ID })
    await h.controller.stop()
  })

  it('is INCLUSIVE at the threshold — a level exactly at audioThresholdDbfs triggers', async () => {
    const h = makeHarness(AUDIO_ONLY_BAND)
    await h.controller.start()
    await h.controller.onAudioLevel(DEVICE_ID, -30, Date.now())
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    await h.controller.stop()
  })

  it('a QUIET window (dbfs below threshold) does NOT pin anything', async () => {
    const h = makeHarness(AUDIO_ONLY_BAND)
    await h.controller.start()
    await h.controller.onAudioLevel(DEVICE_ID, -45, Date.now())
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()
    await h.controller.stop()
  })

  it('a band that only listens to motion is NOT armed by any audio level, however loud', async () => {
    const h = makeHarness(MOTION_ONLY_BAND)
    await h.controller.start()
    await h.controller.onAudioLevel(DEVICE_ID, 0, Date.now())
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()
    await h.controller.stop()
  })

  it('no band covers the instant — no crash, no pin', async () => {
    const h = makeHarness({ enabled: true, bands: [] })
    await h.controller.start()
    await h.controller.onAudioLevel(DEVICE_ID, 0, Date.now())
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()
    await h.controller.stop()
  })

  it('a config-read failure is logged and skips this window — it does not throw', async () => {
    const h = makeHarness(AUDIO_ONLY_BAND)
    await h.controller.start()
    h.failNextConfigLoad()
    await expect(h.controller.onAudioLevel(DEVICE_ID, -10, Date.now())).resolves.toBeUndefined()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()
    const warns = loggerMock.warn.mock.calls.filter((c) =>
      String(c[0]).includes('audio trigger qualification skipped'),
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]![1]).toMatchObject({ tags: { deviceId: DEVICE_ID } })
    await h.controller.stop()
  })

  it('a later qualifying window still triggers after an earlier failed read', async () => {
    const h = makeHarness(AUDIO_ONLY_BAND)
    await h.controller.start()
    h.failNextConfigLoad()
    await h.controller.onAudioLevel(DEVICE_ID, -10, Date.now())
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    await h.controller.onAudioLevel(DEVICE_ID, -10, Date.now())
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    await h.controller.stop()
  })
})
