/**
 * RecordingController write-path resilience.
 *
 * Regression for the multi-hour recording gap (cam99, 2026-06-17 21:59 UTC):
 * the per-profile ffmpeg `SegmentWriter` exhausted its bounded inner restarts
 * and SILENTLY gave up. The controller still held the device in `active` with a
 * dead writer, so `evaluateDevice` short-circuited at "already recording —
 * converged" forever; the broker source (whose only consumer was that writer's
 * RTSP read) went idle and recording stopped until an unrelated viewer re-dialed.
 *
 * The fix wires `SegmentWriter.onGaveUp` → `recoverWriterGaveUp`: detach the
 * device (release the broker lease) and re-evaluate so a fresh writer set is
 * re-attached — the OUTER bounded retry. These tests pin that behaviour.
 */

import path from 'node:path'
import { nodePin, type RecordingConfig } from '@camstack/types'
import type { IScopedLogger, ProfileSlot } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { specRoot } from './spec-root.js'
import { DEFAULT_SEGMENT_SECONDS } from '../recorder-defaults'
import { settleUntil } from './settle.js'

/** One scratch root per RUN, not one shared path per runner. See `./spec-root.ts`. */
const SPEC_ROOT_CONTROLLER = specRoot('rec-controller-spec')
const SPEC_ROOT_CONTROLLER_HIGH = specRoot('rec-controller-spec-high')
const SPEC_ROOT_CONTROLLER_LOW = specRoot('rec-controller-spec-low')
const SPEC_ROOT_CONTROLLER_VOL_A = specRoot('rec-controller-spec-vol-a')
const SPEC_ROOT_CONTROLLER_VOL_B = specRoot('rec-controller-spec-vol-b')
import {
  RECONCILE_TICK_MS,
  RecordingController,
  type RecordingControllerDeps,
} from '../recording-controller'
import { type RecordingsLocation, recordingsLocationOfMode } from '../roots.js'

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
const logger: IScopedLogger = loggerMock

/** A device with one always-on continuous band (start === end + empty days =>
 *  active at every instant per the band engine). */
const CONTINUOUS_CONFIG: RecordingConfig = {
  enabled: true,
  bands: [{ mode: 'continuous', days: [], start: '00:00', end: '00:00' }],
}

interface Harness {
  controller: RecordingController
  procs: FakeProc[]
  spawn: ReturnType<typeof vi.fn>
  getStreamWithCodec: ReturnType<typeof vi.fn>
  releaseStreamWithCodec: ReturnType<typeof vi.fn>
  listAllProfileSlots: ReturnType<typeof vi.fn>
  onFinalizedCalls: { locationId: string; locationRoot: string; flatAbsPath: string }[]
  fireBrokerReady: () => void
}

interface HarnessOptions {
  /** Resolved recordings locations (default: one `recordings` tmpdir root). */
  locations?: readonly RecordingsLocation[]
  /** Broker-assigned profile slots (default: one `high` slot for device 99). */
  slots?: readonly ProfileSlot[]
  /** Recorder default segment seconds (default 4). */
  segmentSeconds?: number
  /** Ingest-owner node the controller pins every broker call to (default 'hub'). */
  ownerNodeId?: string
  /** The node's pinned ffmpeg (default: resolves `/deps/ffmpeg-pinned`). */
  resolveFfmpeg?: () => Promise<string>
  /** Segment-watcher factory (default: the real filesystem watcher). */
  startWatcher?: RecordingControllerDeps['startWatcher']
}

function makeHarness(config: RecordingConfig, opts: HarnessOptions = {}): Harness {
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
  const listAllProfileSlots = vi.fn(
    async () =>
      opts.slots ?? [
        {
          deviceId: 99,
          profile: 'high',
          brokerId: '99/high',
          sourceCamStreamId: 'native:sub',
          status: 'streaming',
        },
      ],
  )

  const api = {
    streamBroker: {
      getStreamWithCodec: { mutate: getStreamWithCodec },
      releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      listAllProfileSlots: { query: listAllProfileSlots },
    },
  } as never

  let readyHandler: (() => void) | null = null

  const onFinalizedCalls: { locationId: string; locationRoot: string; flatAbsPath: string }[] = []
  const deps: RecordingControllerDeps = {
    resolveFfmpeg: opts.resolveFfmpeg ?? (async () => '/deps/ffmpeg-pinned'),
    api,
    logger,
    nodeId: 'hub',
    ownerNodeId: opts.ownerNodeId ?? 'hub',
    segmentStore: {
      onFinalized: vi.fn(async (input: (typeof onFinalizedCalls)[number]) => {
        onFinalizedCalls.push(input)
        return null
      }),
    } as never,
    loadConfig: async () => config,
    enabledDeviceIds: async () => [99],
    locations: () =>
      opts.locations ?? [
        recordingsLocationOfMode(
          { id: 'recordings:default', type: 'recordings', root: SPEC_ROOT_CONTROLLER },
          'active',
        ),
      ],
    spawn: spawn as never,
    segmentSeconds: opts.segmentSeconds ?? 4,
    // Long watch interval so the watcher's setInterval never fires under fake
    // timers (we only advance time for the writer's restart backoff).
    watchIntervalMs: 3_600_000,
    onBrokerReady: (handler) => {
      readyHandler = handler
      return () => {
        readyHandler = null
      }
    },
    brokerCall: (fn) => fn(),
    ...(opts.startWatcher ? { startWatcher: opts.startWatcher } : {}),
  }

  return {
    controller: new RecordingController(deps),
    procs,
    spawn,
    getStreamWithCodec,
    releaseStreamWithCodec,
    listAllProfileSlots,
    onFinalizedCalls,
    fireBrokerReady: () => readyHandler?.(),
  }
}

type WatcherFactory = NonNullable<RecordingControllerDeps['startWatcher']>
type WatcherOptions = Parameters<WatcherFactory>[0]

/**
 * A watcher that does no I/O and lets the spec FINALIZE a segment for one
 * profile, as ffmpeg would — the only proof a writer is producing.
 */
function capturingWatcher(): {
  readonly factory: WatcherFactory
  finalize(profile: 'high' | 'low'): Promise<void>
} {
  const opened: WatcherOptions[] = []
  return {
    factory: (watcherOpts) => {
      opened.push(watcherOpts)
      return { stop: () => {}, flush: async () => {} }
    },
    finalize: async (profile) => {
      const latest = opened.findLast((o) => o.outDir.includes(`/99/${profile}`))
      if (!latest) throw new Error(`no watcher for ${profile}`)
      const startMs = Date.now()
      await latest.onFinalized(startMs, 10_000, path.join(latest.outDir, `${startMs}.m4s`))
    },
  }
}

/** Fire enough rapid exits to exhaust SegmentWriter's MAX_RESTARTS (10). */
async function driveWriterToGiveUp(proc0: FakeProc, procs: FakeProc[]): Promise<void> {
  proc0.fireExit(1)
  // 10 consecutive restarts, each behind an exponential backoff capped at 10s.
  for (let attempt = 1; attempt <= 10; attempt++) {
    await vi.advanceTimersByTimeAsync(10_000)
    const next = procs[procs.length - 1]!
    next.fireExit(1)
  }
}

describe('RecordingController writer give-up recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(async () => {
    vi.useRealTimers()
  })

  it('pins the broker source for a continuous-band device on start', async () => {
    const h = makeHarness(CONTINUOUS_CONFIG)
    await h.controller.start()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(h.getStreamWithCodec.mock.calls[0]![0]).toMatchObject({ deviceId: 99, video: 'copy' })
    await h.controller.stop()
  })

  it('does NOT pin a device whose config is disabled', async () => {
    const h = makeHarness({ enabled: false, bands: [] })
    await h.controller.start()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()
    await h.controller.stop()
  })

  it('re-attaches a fresh writer after the writer gives up (recovers the gap)', async () => {
    const h = makeHarness(CONTINUOUS_CONFIG)
    await h.controller.start()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(h.procs.length).toBe(1)

    // The writer exhausts its bounded inner restarts and gives up.
    await driveWriterToGiveUp(h.procs[0]!, h.procs)
    // Wait for the recovery to LAND, not for 50 turns. Recovery is not
    // microtask-only: the detach re-reads the watcher's playlist and the
    // re-attach `mkdir`s the staging dir, both real filesystem work whose
    // latency belongs to the machine. See `./settle.ts`.
    await settleUntil(
      () => h.getStreamWithCodec.mock.calls.length >= 2,
      'the give-up recovery re-acquired the broker source',
    )

    // Recovery released the dead device's lease and re-acquired a fresh one —
    // the device is pinned again rather than left permanently dead.
    expect(h.releaseStreamWithCodec).toHaveBeenCalled()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(2)

    await h.controller.stop()
  })

  it('coalesces concurrent attaches — no duplicate writer set for one device (race guard)', async () => {
    const h = makeHarness(CONTINUOUS_CONFIG)
    // Two evaluate passes race in the same tick (rapid motion triggers, or a
    // tick concurrent with give-up recovery). `evaluateDevice` checks
    // `active.has(deviceId)` BEFORE a chain of awaits (loadConfig, resolveProfiles,
    // getStreamWithCodec, mkdir, spawn) and only `active.set`s at the END — so both
    // passes saw the device as not-yet-active and (pre-fix) each spawned a full
    // writer set. Those duplicates double-write the same rec-tmp dir with the same
    // `%s.m4s` names → colliding/28-byte segments + relocate ENOENT races.
    await Promise.all([
      h.controller.onTrigger(99, { kind: 'motion' }, 1_000),
      h.controller.onTrigger(99, { kind: 'motion' }, 1_000),
    ])
    // One profile => exactly ONE spawned writer + ONE broker acquire.
    expect(h.procs.length).toBe(1)
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    await h.controller.stop()
  })

  it('stages segments under the PLACEMENT root (.rec-tmp) so relocate is always same-fs', async () => {
    // Two "volumes": high/mid footage on vol-a, low footage on vol-b. The
    // profile is `low`, so its placement root is vol-b — the ffmpeg staging
    // outDir MUST live under vol-b too (`<root>/.rec-tmp/<dev>/<profile>`),
    // otherwise the rec-tmp→final relocate crosses filesystems and the EXDEV
    // fallback rewrites every segment (2x disk writes — F1).
    const volA = SPEC_ROOT_CONTROLLER_VOL_A
    const volB = SPEC_ROOT_CONTROLLER_VOL_B
    const h = makeHarness(CONTINUOUS_CONFIG, {
      locations: [
        recordingsLocationOfMode(
          { id: 'recordings:default', type: 'recordings', root: volA },
          'active',
        ),
        recordingsLocationOfMode(
          { id: 'recordingsLow:default', type: 'recordingsLow', root: volB },
          'active',
        ),
      ],
      slots: [
        {
          deviceId: 99,
          profile: 'low',
          brokerId: '99/low',
          sourceCamStreamId: 'native:low',
          status: 'streaming',
        },
      ],
    })
    await h.controller.start()

    expect(h.spawn).toHaveBeenCalledTimes(1)
    const args = h.spawn.mock.calls[0]![1] as readonly string[]
    const expectedOutDir = path.join(volB, '.rec-tmp', '99', 'low')
    // ffmpeg writes the flat segments + rolling playlist into the staging dir.
    expect(args).toContain(`${expectedOutDir}/%s.m4s`)
    expect(args).toContain(`${expectedOutDir}/live.m3u8`)
    await h.controller.stop()
  })

  it('does not re-acquire after stop() even if a writer exit fires late', async () => {
    const h = makeHarness(CONTINUOUS_CONFIG)
    await h.controller.start()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
    const acquiresAfterStop = h.getStreamWithCodec.mock.calls.length

    // A late exit on the (already-stopped) writer must not trigger any recovery
    // re-acquire — the controller's `stopped` guard wins.
    h.procs[0]!.fireExit(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.getStreamWithCodec.mock.calls.length).toBe(acquiresAfterStop)
  })
})

describe('RecordingController — the pinned ffmpeg (D540)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('REFUSES the writer before placement or dial when the pinned ffmpeg cannot be had, and RECOVERS on the next pass', async () => {
    let available = false
    const h = makeHarness(CONTINUOUS_CONFIG, {
      resolveFfmpeg: async () => {
        if (!available) throw new Error('download failed')
        return '/deps/ffmpeg-pinned'
      },
    })
    await h.controller.start()

    // Nothing dialled, nothing spawned — in particular not a PATH `ffmpeg`.
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('no pinned ffmpeg'),
      expect.objectContaining({ tags: { deviceId: 99 } }),
    )

    // The binary arrives; the next broker-ready / reconcile pass attaches.
    available = true
    h.fireBrokerReady()
    await vi.advanceTimersByTimeAsync(125_000)
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled())
    expect(h.spawn.mock.calls[0]![0]).toBe('/deps/ffmpeg-pinned')
    await h.controller.stop()
  })
})

describe('RecordingController per-profile attach (one dead stream must not stop the rest)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(async () => {
    vi.useRealTimers()
  })

  const HIGH_LOW_SLOTS: readonly ProfileSlot[] = [
    {
      deviceId: 99,
      profile: 'high',
      sourceCamStreamId: 'native:main',
      brokerId: '99/high',
      status: 'streaming',
    },
    {
      deviceId: 99,
      profile: 'low',
      sourceCamStreamId: 'derived:Mid to low',
      brokerId: '99/low',
      status: 'error',
    },
  ]

  const TWO_VOLUMES: HarnessOptions = {
    locations: [
      recordingsLocationOfMode(
        { id: 'recordings:default', type: 'recordings', root: SPEC_ROOT_CONTROLLER_HIGH },
        'active',
      ),
      recordingsLocationOfMode(
        { id: 'recordingsLow:default', type: 'recordingsLow', root: SPEC_ROOT_CONTROLLER_LOW },
        'active',
      ),
    ],
    slots: HIGH_LOW_SLOTS,
  }

  it('pins high when low getStreamWithCodec throws — no rollback of the healthy profile', async () => {
    // Live 618: low was `derived:Mid to low` without a catalog `url`, so
    // getStreamWithCodec threw and performAttach rolled back high too — zero
    // footage for hours. A dead slot must skip; the others stay pinned.
    const h = makeHarness(CONTINUOUS_CONFIG, TWO_VOLUMES)
    h.getStreamWithCodec.mockImplementation(async (input: { profile?: string }) => {
      if (input.profile === 'low') {
        throw new Error(
          'getStreamWithCodec: profile "low" source "derived:Mid to low" not published for device 99',
        )
      }
      return {
        url: 'rtsp://127.0.0.1:8554/cam99-high',
        videoCodec: 'H265' as const,
        audioCodec: 'aac' as const,
        resolution: { width: 2560, height: 1440 },
        transcoded: false,
        encoder: 'copy',
        pipelineKey: 'pk-high',
      }
    })

    await h.controller.start()

    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.releaseStreamWithCodec).not.toHaveBeenCalled()
    const profiles = h.getStreamWithCodec.mock.calls.map(
      (c) => (c[0] as { profile?: string }).profile,
    )
    expect(profiles).toEqual(expect.arrayContaining(['high', 'low']))

    await h.controller.stop()
  })

  it('retries the missing profile on the next RECONCILE pass without tearing down high', async () => {
    // 60 s segments so the liveness watchdog's idle bound
    // (`max(90s, 3 x segmentSeconds)` = 180 s) stays clear of the reconcile beat
    // this test advances through. Otherwise the pinned-but-silent recovery — a
    // different mechanism entirely — would detach the device first and the
    // assertion below would be measuring the wrong thing.
    const h = makeHarness({ ...CONTINUOUS_CONFIG, segmentSeconds: 60 }, TWO_VOLUMES)
    let lowAttempts = 0
    h.getStreamWithCodec.mockImplementation(async (input: { profile?: string }) => {
      if (input.profile === 'low') {
        lowAttempts += 1
        if (lowAttempts === 1) {
          throw new Error(
            'getStreamWithCodec: profile "low" source "derived:Mid to low" not published for device 99',
          )
        }
        return {
          url: 'rtsp://127.0.0.1:8554/cam99-low',
          videoCodec: 'H264' as const,
          audioCodec: 'aac' as const,
          resolution: { width: 640, height: 360 },
          transcoded: false,
          encoder: 'copy',
          pipelineKey: 'pk-low',
        }
      }
      return {
        url: 'rtsp://127.0.0.1:8554/cam99-high',
        videoCodec: 'H265' as const,
        audioCodec: 'aac' as const,
        resolution: { width: 2560, height: 1440 },
        transcoded: false,
        encoder: 'copy',
        pipelineKey: 'pk-high',
      }
    })

    await h.controller.start()
    expect(h.spawn).toHaveBeenCalledTimes(1)

    // The skipped-profile retry rides the reconcile, which is the recorder's
    // safety net and no longer its 30 s heartbeat.
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2))
    expect(h.releaseStreamWithCodec).not.toHaveBeenCalled()

    await h.controller.stop()
  })

  it('recovers a dead high writer without unpinning a healthy low (timeline/scrub profile)', async () => {
    // Live 2026-08-22: high on 101/104/102/586 stalled 139 s. Recovery detached
    // the WHOLE device, so low (the availability bar + scrub profile) stopped
    // too — 38–172 s holes on every continuous camera in the same hour.
    const bothStreaming: HarnessOptions = {
      ...TWO_VOLUMES,
      slots: [
        {
          deviceId: 99,
          profile: 'high',
          sourceCamStreamId: 'native:main',
          brokerId: '99/high',
          status: 'streaming',
        },
        {
          deviceId: 99,
          profile: 'low',
          sourceCamStreamId: 'native:sub',
          brokerId: '99/low',
          status: 'streaming',
        },
      ],
    }
    // 60 s segments so the liveness watchdog's idle bound
    // (`max(90s, 3 x segmentSeconds)` = 180 s) stays clear of the ~100 s of
    // backoff `driveWriterToGiveUp` advances. Otherwise BOTH writers look
    // silent and the idle path would detach the whole device — the mechanism
    // this test is NOT measuring.
    const watcher = capturingWatcher()
    const h = makeHarness(
      { ...CONTINUOUS_CONFIG, segmentSeconds: 60 },
      { ...bothStreaming, startWatcher: watcher.factory },
    )
    await h.controller.start()
    // Low is HEALTHY: it has produced a segment. Only a producing sibling is
    // kept pinned while the stalled profile alone is recovered.
    await watcher.finalize('low')
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.procs).toHaveLength(2)
    const spawnProfile = (call: unknown[]): 'high' | 'low' | null => {
      const args = call[1] as readonly string[]
      if (args.some((a) => a.includes('/99/high'))) return 'high'
      if (args.some((a) => a.includes('/99/low'))) return 'low'
      return null
    }
    const highIdx = h.spawn.mock.calls.findIndex((c) => spawnProfile(c) === 'high')
    const lowIdx = h.spawn.mock.calls.findIndex((c) => spawnProfile(c) === 'low')
    expect(highIdx).toBeGreaterThanOrEqual(0)
    expect(lowIdx).toBeGreaterThanOrEqual(0)
    const lowProc = h.procs[lowIdx]!
    const releasesBefore = h.releaseStreamWithCodec.mock.calls.length

    await driveWriterToGiveUp(h.procs[highIdx]!, h.procs)
    // The high profile's recovery is real filesystem work; wait for it to land.
    await settleUntil(
      () => h.releaseStreamWithCodec.mock.calls.length > releasesBefore,
      'the dead high writer released its broker source',
    )
    await settleUntil(
      () =>
        h.getStreamWithCodec.mock.calls.filter(
          (c) => (c[0] as { profile?: string }).profile === 'high',
        ).length > 1,
      'the high profile was re-acquired',
    )

    expect(lowProc.kill).not.toHaveBeenCalled()
    expect(h.releaseStreamWithCodec.mock.calls.length).toBe(releasesBefore + 1)
    const profiles = h.getStreamWithCodec.mock.calls.map(
      (c) => (c[0] as { profile?: string }).profile,
    )
    expect(profiles.filter((p) => p === 'low')).toHaveLength(1)
    expect(profiles.filter((p) => p === 'high').length).toBeGreaterThan(1)
    const kept = loggerMock.warn.mock.calls.find(
      (c) =>
        c[0] ===
        'recorder: writer gave up — recovering stalled profile, healthy profiles keep recording',
    )
    expect(kept?.[1]).toMatchObject({ meta: { profile: ['high'], keeping: ['low'] } })

    await h.controller.stop()
  })

  it('never claims a sibling "keeps recording" when no profile produced a segment (all stalled)', async () => {
    // Live 108, 2026-10-22 13:18–13:25: the camera had no power, both writers
    // gave up 20–150 ms apart, and each give-up logged "healthy profiles keep
    // recording" naming the OTHER — `keeping: ["high"]` / `keeping: ["low"]` —
    // while neither had finalized a segment since it was pinned.
    const watcher = capturingWatcher()
    const h = makeHarness(
      { ...CONTINUOUS_CONFIG, segmentSeconds: 60 },
      {
        ...TWO_VOLUMES,
        startWatcher: watcher.factory,
        slots: [
          {
            deviceId: 99,
            profile: 'high',
            sourceCamStreamId: 'native:main',
            brokerId: '99/high',
            status: 'streaming',
          },
          {
            deviceId: 99,
            profile: 'low',
            sourceCamStreamId: 'native:sub',
            brokerId: '99/low',
            status: 'streaming',
          },
        ],
      },
    )
    await h.controller.start()
    expect(h.procs).toHaveLength(2)
    const highIdx = h.spawn.mock.calls.findIndex((c) =>
      (c[1] as readonly string[]).some((a) => a.includes('/99/high')),
    )
    const lowProc = h.procs[highIdx === 0 ? 1 : 0]!
    const releasesBefore = h.releaseStreamWithCodec.mock.calls.length

    await driveWriterToGiveUp(h.procs[highIdx]!, h.procs)
    await settleUntil(
      () => h.releaseStreamWithCodec.mock.calls.length >= releasesBefore + 2,
      'the whole device was released',
    )

    const messages = loggerMock.warn.mock.calls.map((c) => c[0])
    expect(messages).not.toContain(
      'recorder: writer gave up — recovering stalled profile, healthy profiles keep recording',
    )
    const allStalled = loggerMock.warn.mock.calls.find(
      (c) =>
        c[0] ===
        'recorder: writer gave up — no profile produced a segment recently (all stalled) — detaching + re-evaluating device',
    )
    expect(allStalled?.[1]).toMatchObject({
      tags: { deviceId: 99 },
      meta: { profile: 'high', stalledSiblings: ['low'] },
    })
    // The decision follows the log: the silent sibling is torn down with it.
    expect(lowProc.kill).toHaveBeenCalled()

    await h.controller.stop()
  })
})

describe('RecordingController segment length resolution (R3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves to the 10s addon default when the device config omits segmentSeconds', async () => {
    // The default segment length is 10s (R3: fewer files → less metadata wear).
    expect(DEFAULT_SEGMENT_SECONDS).toBe(10)
    const h = makeHarness(CONTINUOUS_CONFIG, { segmentSeconds: DEFAULT_SEGMENT_SECONDS })
    await h.controller.start()
    const args = h.spawn.mock.calls[0]![1] as readonly string[]
    expect(args[args.indexOf('-segment_time') + 1]).toBe('10')
    await h.controller.stop()
  })

  it('still honors an explicit per-device segmentSeconds override', async () => {
    const h = makeHarness(
      { ...CONTINUOUS_CONFIG, segmentSeconds: 6 },
      { segmentSeconds: DEFAULT_SEGMENT_SECONDS },
    )
    await h.controller.start()
    const args = h.spawn.mock.calls[0]![1] as readonly string[]
    expect(args[args.indexOf('-segment_time') + 1]).toBe('6')
    await h.controller.stop()
  })
})

describe('RecordingController trigger during the boot publication race', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('onTrigger never rejects when the profile is not yet published — logs a tagged deferral and re-attaches on broker ready', async () => {
    const h = makeHarness(CONTINUOUS_CONFIG)
    // Boot race: the broker cap is `ready` but the profile is not published
    // yet — exactly the storm observed 2026-08-01 06:59:30–06:59:53 on
    // devices 101/102, where each motion tick's `void onTrigger(...)` leaked
    // the rejection to the process and printed an `[addon-runner CRASH]
    // unhandledRejection` marker once a second.
    const notPublished = new Error(
      'getStreamWithCodec: profile "high" source "native:main" not published for device 99',
    )
    h.getStreamWithCodec.mockRejectedValue(notPublished)
    await h.controller.start() // boot restore defers (caught by the queue)

    // The fire-and-forget trigger path must not reject.
    await expect(h.controller.onTrigger(99, { kind: 'motion' }, 1_000)).resolves.toBeUndefined()

    // The deferral is LOGGED, per-device (tags.deviceId), naming the retry.
    const warn = loggerMock.warn.mock.calls.find((c) =>
      String(c[0]).includes('trigger attach deferred'),
    )
    expect(warn).toBeDefined()
    expect(warn![1]).toMatchObject({ tags: { deviceId: 99 } })

    // The trigger was deferred, not dropped: once the stream publishes and the
    // broker signals ready, the device attaches.
    h.getStreamWithCodec.mockResolvedValue({
      url: 'rtsp://127.0.0.1:8554/cam99-sub',
      videoCodec: 'H265' as const,
      audioCodec: 'aac' as const,
      resolution: { width: 1280, height: 720 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: 'pk-after-publish',
    })
    h.fireBrokerReady()
    await vi.waitFor(() => expect(h.procs.length).toBe(1))

    await h.controller.stop()
  })
})

describe('RecordingController bounded shutdown (SIGTERM grace)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stop() completes inside the supervisor 5s SIGTERM grace even when the broker release RPC hangs', async () => {
    // A watcher whose flush does no filesystem I/O: the real one reads the
    // playlist from disk, which interleaves real I/O with fake timers.
    const h = makeHarness(CONTINUOUS_CONFIG, {
      startWatcher: () => ({ stop: () => {}, flush: async () => {} }),
    })
    await h.controller.start()
    expect(h.procs.length).toBe(1)

    // A redeploy restarts the broker: the release RPC never settles (the UDS
    // default timeout is 60s — far beyond the 5s grace). Pre-fix, stop()
    // awaited it unbounded, the runner blew the grace and was SIGKILLed
    // (`signal=SIGKILL state=stopped`, observed 2026-08-01 04:08–04:24).
    h.releaseStreamWithCodec.mockImplementation(() => new Promise(() => {}))

    let stopped = false
    const stopP = h.controller.stop().then(() => {
      stopped = true
    })

    // The watcher is a no-I/O fake (see `makeHarness` call above), so every
    // step of the teardown is microtask-only and the only pending timer is the
    // bounded release's. Advance fake time to the grace limit: `stop()` must
    // settle inside 5 000 ms of FAKE time. Restore the unbounded release (the
    // 60 s UDS default) and nothing settles it, so `stopped` stays false.
    const MAX_FAKE_MS = 5_000
    await vi.advanceTimersByTimeAsync(MAX_FAKE_MS)
    expect(stopped).toBe(true)
    await stopP

    // The dropped release is logged with the device tag — never silent.
    const warn = loggerMock.warn.mock.calls.find((c) =>
      String(c[0]).includes('releaseStreamWithCodec failed'),
    )
    expect(warn).toBeDefined()
    expect(warn![1]).toMatchObject({ tags: { deviceId: 99 } })
  })
})

describe('RecordingController ingest-owner node pin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pins every broker call to a non-hub ingest owner', async () => {
    const h = makeHarness(CONTINUOUS_CONFIG, { ownerNodeId: 'owner-x' })
    await h.controller.start()

    expect(h.listAllProfileSlots).toHaveBeenCalledTimes(1)
    expect(h.listAllProfileSlots.mock.calls[0]![1]).toEqual(nodePin('owner-x'))

    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(h.getStreamWithCodec.mock.calls[0]![1]).toEqual(nodePin('owner-x'))

    await h.controller.stop()
    expect(h.releaseStreamWithCodec.mock.calls[0]![1]).toEqual(nodePin('owner-x'))
  })

  it('regression: still pins to hub when ownerNodeId is hub (byte-identical target)', async () => {
    const h = makeHarness(CONTINUOUS_CONFIG, { ownerNodeId: 'hub' })
    await h.controller.start()

    expect(h.listAllProfileSlots).toHaveBeenCalledTimes(1)
    expect(h.listAllProfileSlots.mock.calls[0]![1]).toEqual(nodePin('hub'))

    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(h.getStreamWithCodec.mock.calls[0]![1]).toEqual(nodePin('hub'))

    await h.controller.stop()
    expect(h.releaseStreamWithCodec.mock.calls[0]![1]).toEqual(nodePin('hub'))
  })
})

/**
 * Events-mode write path — the regression for "configured to record, never
 * recorded a frame, never logged a line".
 *
 * The Basic recording form omits `preBufferSec`/`postBufferSec` entirely when
 * the operator leaves them blank, so the persisted band is
 * `{mode:'events', triggers:{motion:true}}`. Read with `?? 0` that made the
 * live demand window zero-length: `onTrigger` set the timestamp, `evaluateDevice`
 * asked "is now within 0 ms of the trigger" a few ms later, got false, and took
 * the SILENT `!wantRecording` branch. Two hub cameras sat there for weeks with
 * `ranges: []` and not one recorder log line.
 */
describe('RecordingController events-band gating', () => {
  const EVENTS_NO_BUFFERS: RecordingConfig = {
    enabled: true,
    bands: [{ mode: 'events', days: [], start: '00:00', end: '00:00', triggers: { motion: true } }],
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not pin anything before a trigger', async () => {
    const h = makeHarness(EVENTS_NO_BUFFERS)
    await h.controller.start()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()
    await h.controller.stop()
  })

  it('pins the broker source on a motion trigger even with NO postBufferSec authored', async () => {
    const h = makeHarness(EVENTS_NO_BUFFERS)
    await h.controller.start()
    await h.controller.onTrigger(99, { kind: 'motion' }, Date.now() - 1_000)
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(h.getStreamWithCodec.mock.calls[0]![0]).toMatchObject({ deviceId: 99 })
    await h.controller.stop()
  })

  it('names the drop when an events band can NEVER open a window (explicit 0)', async () => {
    const h = makeHarness({
      enabled: true,
      bands: [
        {
          mode: 'events',
          days: [],
          start: '00:00',
          end: '00:00',
          triggers: { motion: true },
          postBufferSec: 0,
        },
      ],
    })
    await h.controller.start()
    await h.controller.onTrigger(99, { kind: 'motion' }, Date.now() - 1_000)
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    const warns = loggerMock.warn.mock.calls.filter((c) =>
      String(c[0]).includes('can never open a recording window'),
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]![1]).toMatchObject({ tags: { deviceId: 99 } })
    await h.controller.stop()
  })

  it('names an enabled device that has no bands at all', async () => {
    const h = makeHarness({ enabled: true, bands: [] })
    await h.controller.start()
    const warns = loggerMock.warn.mock.calls.filter((c) =>
      String(c[0]).includes('has no recording bands'),
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]![1]).toMatchObject({ tags: { deviceId: 99 } })
    await h.controller.stop()
  })

  it('warns ONCE per device, not once per evaluate', async () => {
    const h = makeHarness({ enabled: true, bands: [] })
    await h.controller.start()
    await h.controller.onConfigChanged(99)
    await h.controller.onConfigChanged(99)
    const warns = loggerMock.warn.mock.calls.filter((c) =>
      String(c[0]).includes('has no recording bands'),
    )
    expect(warns).toHaveLength(1)
    await h.controller.stop()
  })

  it('stays silent for a healthy events band merely waiting for its next trigger', async () => {
    const h = makeHarness(EVENTS_NO_BUFFERS)
    await h.controller.start()
    await h.controller.onConfigChanged(99)
    const warns = loggerMock.warn.mock.calls.filter(
      (c) =>
        String(c[0]).includes('can never open a recording window') ||
        String(c[0]).includes('has no recording bands'),
    )
    expect(warns).toHaveLength(0)
    await h.controller.stop()
  })
})
