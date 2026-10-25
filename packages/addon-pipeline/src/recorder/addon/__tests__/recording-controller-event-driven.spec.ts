/**
 * The recorder converges on EVENTS; the periodic pass is only a backstop.
 *
 * Before 2026-08-18 a trigger could only ever OPEN an `events` window: the
 * sliding demand window (`atMs - lastMotionMs <= postMs`) is anchored on the
 * LAST trigger, so nothing called `evaluateDevice` at the instant the window
 * closed. The detach therefore happened on the 30 s convergence pass — a 4K
 * camera stayed dialled, decoded and written for up to a full tick past the
 * operator's `postBufferSec`. That same pass also re-planned placement and
 * re-attached every device, and on 2026-08-18 it blocked for 60 001 ms (3 x the
 * 20 s attach RPC bound) while the broker cold-dialled ~40 RTSP sources.
 *
 * These tests pin the split:
 *
 *  - the DETACH is armed for the instant the window closes, not discovered by a
 *    scan (and a fresher trigger re-arms it later, so continuous motion is still
 *    ONE recording — the observable contract must not change);
 *  - a BAND EDGE is armed from the band model, not discovered by a scan;
 *  - the RECONCILE still exists and still recovers everything an event cannot:
 *    a wake-up lost to a failure on the event path, a state change nobody
 *    announced, and an attach that failed because the broker was not ready;
 *  - a not-ready broker costs the attach path NOTHING — no `listAllProfileSlots`,
 *    no `getStreamWithCodec`, no 20 s timeout per profile.
 *
 * `segmentSeconds` is deliberately large in every harness here so the liveness
 * watchdog's idle bound (`max(90s, segmentSeconds * 3)`) cannot fire inside the
 * window a test advances through and detach the device for the wrong reason.
 */

import type { RecordingBand, RecordingConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { specRoot } from './spec-root.js'
import { settleTurns, settleUntil } from './settle.js'

/** One scratch root per RUN, not one shared path per runner. See `./spec-root.ts`. */
const SPEC_ROOT = specRoot('rec-event-driven-spec')
import {
  RECONCILE_TICK_MS,
  RecordingController,
  type RecordingControllerDeps,
} from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'

const DEVICE_ID = 99
const POST_BUFFER_SEC = 45
const POST_MS = POST_BUFFER_SEC * 1000
/** Long enough that `writerIdleBoundMs` (>= 3 x segmentSeconds) never fires here. */
const SEGMENT_SECONDS = 600

interface FakeProc {
  kill: ReturnType<typeof vi.fn>
  on: (ev: string, cb: (...a: unknown[]) => void) => void
  stderr: { on: () => void }
}

function makeFakeProc(): FakeProc {
  return { kill: vi.fn(), on: () => {}, stderr: { on: () => {} } }
}

interface LogCall {
  readonly level: 'info' | 'warn' | 'debug'
  readonly msg: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface Harness {
  readonly controller: RecordingController
  readonly logs: LogCall[]
  readonly spawn: ReturnType<typeof vi.fn>
  readonly getStreamWithCodec: ReturnType<typeof vi.fn>
  readonly releaseStreamWithCodec: ReturnType<typeof vi.fn>
  readonly listAllProfileSlots: ReturnType<typeof vi.fn>
  readonly placementTicks: number[][]
  setConfig(config: RecordingConfig): void
  setBrokerReady(ready: boolean): void
  failNextConfigLoad(): void
  /** Wedge every subsequent config read — the shape of a reconcile stuck on a slow dependency. */
  blockConfigLoads(): void
  fireBrokerReady(): void
}

interface HarnessOptions {
  readonly brokerReady?: boolean
  readonly withPlacement?: boolean
}

/** An always-covering events band on motion, 45 s post-buffer. */
function eventsConfig(): RecordingConfig {
  return {
    enabled: true,
    segmentSeconds: SEGMENT_SECONDS,
    bands: [
      {
        mode: 'events',
        days: [],
        start: '00:00',
        end: '00:00',
        triggers: { motion: true },
        preBufferSec: 5,
        postBufferSec: POST_BUFFER_SEC,
      },
    ],
  }
}

/** An always-covering continuous band. */
function continuousConfig(): RecordingConfig {
  return {
    enabled: true,
    segmentSeconds: SEGMENT_SECONDS,
    bands: [{ mode: 'continuous', days: [], start: '00:00', end: '00:00' }],
  }
}

function makeHarness(initial: RecordingConfig, opts: HarnessOptions = {}): Harness {
  let config = initial
  let brokerReady = opts.brokerReady ?? true
  let failNextLoad = false
  let blockLoads = false
  let readyHandler: (() => void) | null = null
  const logs: LogCall[] = []
  const placementTicks: number[][] = []

  const record =
    (level: LogCall['level'], bound: Record<string, unknown>) =>
    (msg: string, fields?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> }) => {
      logs.push({ level, msg, meta: fields?.meta ?? {}, tags: { ...bound, ...fields?.tags } })
    }
  const makeLogger = (bound: Record<string, unknown>): Record<string, unknown> => ({
    info: record('info', bound),
    warn: record('warn', bound),
    error: record('warn', bound),
    debug: record('debug', bound),
    child: () => makeLogger(bound),
    withTags: (extra: Record<string, unknown>) => makeLogger({ ...bound, ...extra }),
  })

  const spawn = vi.fn(() => makeFakeProc())
  let acquireSeq = 0
  const getStreamWithCodec = vi.fn(async () => ({
    url: 'rtsp://127.0.0.1:8554/cam99-high',
    videoCodec: 'H265' as const,
    audioCodec: 'aac' as const,
    resolution: { width: 3840, height: 2160 },
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
    logger: makeLogger({}) as never,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: { onFinalized: async () => null } as never,
    loadConfig: async () => {
      if (failNextLoad) {
        failNextLoad = false
        throw new Error('config store unavailable')
      }
      if (blockLoads) await new Promise<never>(() => {})
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
    segmentSeconds: SEGMENT_SECONDS,
    // Long enough that the watcher's own interval never fires in these tests.
    watchIntervalMs: 3_600_000,
    onBrokerReady: (handler) => {
      readyHandler = handler
      return () => {
        readyHandler = null
      }
    },
    brokerCall: (fn) => fn(),
    brokerReady: () => brokerReady,
    ...(opts.withPlacement === true
      ? {
          onPlacementTick: async (deviceIds: readonly number[]) => {
            placementTicks.push([...deviceIds])
          },
        }
      : {}),
  }

  return {
    controller: new RecordingController(deps),
    logs,
    spawn,
    getStreamWithCodec,
    releaseStreamWithCodec,
    listAllProfileSlots,
    placementTicks,
    setConfig: (next) => {
      config = next
    },
    setBrokerReady: (ready) => {
      brokerReady = ready
    },
    failNextConfigLoad: () => {
      failNextLoad = true
    },
    blockConfigLoads: () => {
      blockLoads = true
    },
    fireBrokerReady: () => readyHandler?.(),
  }
}

/**
 * Let the controller's fire-and-forget async work settle without moving the
 * clock. ONLY before an assertion that something did NOT happen — a counted
 * drain cannot make an absence false. Before an assertion that something DID
 * happen, wait for it by name with `settleUntil`; that is what run
 * 35497173489 failed for (`expected "spy" to be called 1 times, but got 0
 * times`: the detach had not landed inside 20 turns on a loaded runner).
 * See `./settle.ts`.
 */
async function settle(): Promise<void> {
  await settleTurns()
}

describe('event-driven detach: the window closes ON TIME, not on the next pass', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * RE-ENABLED 2026-09-20. Commented out on 2026-09-14 as "flaky under host
   * load"; the load was never the defect — `settle()` counted turns and the
   * detach is real filesystem work, so under contention the count ran out
   * before the work landed. It now waits for the landing by name. A test that
   * only runs on an idle machine is a test nobody reads.
   */
  it('detaches an isolated trigger AT `trigger + postBufferSec`, not at the next reconcile', async () => {
    const h = makeHarness(eventsConfig())
    await h.controller.start()
    // No trigger yet: an events band demands nothing, so nothing is pinned.
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    const triggerMs = Date.now()
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, triggerMs)
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(h.releaseStreamWithCodec).not.toHaveBeenCalled()

    // AT the bound the live gate is still inclusive (`<= postMs`) — still recording.
    await vi.advanceTimersByTimeAsync(POST_MS)
    await settle()
    expect(h.releaseStreamWithCodec).not.toHaveBeenCalled()

    // One millisecond past it: detached. The next reconcile is 120 s away and
    // the old convergence beat was 30 s — neither can explain this instant.
    await vi.advanceTimersByTimeAsync(1)
    await settleUntil(
      () => h.releaseStreamWithCodec.mock.calls.length >= 1,
      'the window close released the broker source',
    )
    expect(h.releaseStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(Date.now() - triggerMs).toBe(POST_MS + 1)
    // And the detach is not followed by a re-attach: the window is shut.
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
  })

  it('a fresher trigger RE-ARMS the window — continuous motion is ONE recording, no churn', async () => {
    const h = makeHarness(eventsConfig())
    await h.controller.start()

    const first = Date.now()
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, first)
    expect(h.spawn).toHaveBeenCalledTimes(1)

    // A second trigger 20 s in, while the first window is still open.
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    const second = Date.now()
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, second)

    // Well past the FIRST window's close (first + 45 s) — the recording is
    // unbroken: no release, no second spawn, no second broker acquire.
    await vi.advanceTimersByTimeAsync(first + POST_MS + 5_000 - Date.now())
    await settle()
    expect(Date.now()).toBe(first + POST_MS + 5_000)
    expect(h.releaseStreamWithCodec).not.toHaveBeenCalled()
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    // The SECOND window's close is what ends it, one epsilon past `second + 45s`.
    await vi.advanceTimersByTimeAsync(second + POST_MS - Date.now())
    await settle()
    expect(h.releaseStreamWithCodec).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await settleUntil(
      () => h.releaseStreamWithCodec.mock.calls.length >= 1,
      'the second window closed and released the broker source',
    )
    expect(h.releaseStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(Date.now() - second).toBe(POST_MS + 1)
    // ONE recording, from `first` to `second + 45 s`: one spawn, one acquire,
    // one release. That is the sliding-window contract, unchanged.
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
  })
})

/**
 * The clock starts at 17:59:23 LOCAL, so the 18:00 edge is 37 s away — NOT a
 * multiple of any pass cadence. A test that started on a round minute would
 * pass on the old 30 s convergence beat by coincidence and prove nothing about
 * the arming.
 */
const EDGE_LEAD_MS = 37_000

describe('event-driven band edges: armed from the band model, not scanned for', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 18, 17, 59, 23, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('detaches AT the band edge (18:00), not on the next reconcile', async () => {
    const h = makeHarness({
      enabled: true,
      segmentSeconds: SEGMENT_SECONDS,
      bands: [{ mode: 'continuous', days: [], start: '08:00', end: '18:00' }],
    })
    await h.controller.start()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(EDGE_LEAD_MS - 1)
    await settle()
    expect(h.releaseStreamWithCodec).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await settleUntil(
      () => h.releaseStreamWithCodec.mock.calls.length >= 1,
      'the band edge released the broker source',
    )
    expect(h.releaseStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(new Date().getHours()).toBe(18)
    expect(new Date().getMinutes()).toBe(0)
    expect(new Date().getSeconds()).toBe(0)

    await h.controller.stop()
  })

  it('ATTACHES at the band edge a continuous band starts on', async () => {
    // 17:59:23 local; the band starts at 18:00. Nothing is pinned until then.
    const h = makeHarness({
      enabled: true,
      segmentSeconds: SEGMENT_SECONDS,
      bands: [{ mode: 'continuous', days: [], start: '18:00', end: '23:00' }],
    })
    await h.controller.start()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(EDGE_LEAD_MS - 1)
    await settle()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await settleUntil(
      () => h.getStreamWithCodec.mock.calls.length >= 1,
      'the band edge attached the device',
    )
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
  })
})

describe('the reconcile: rarer and cheaper, and still the only cure for a lost event', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('converges a state change NOBODY announced (the dropped-event shape)', async () => {
    const h = makeHarness({ enabled: false, bands: [] })
    await h.controller.start()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    // The device now wants recording, and the event that would have said so was
    // dropped: no `onConfigChanged`, no trigger, no broker-ready transition.
    h.setConfig(continuousConfig())

    // The OLD convergence beat was 30 s. Nothing happens there any more.
    await vi.advanceTimersByTimeAsync(30_000)
    await settle()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    // The reconcile is what recovers it.
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS - 30_000)
    await settle()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
  })

  it('recovers a wake-up LOST on the event path (the scheduled re-evaluation threw)', async () => {
    const h = makeHarness(eventsConfig())
    await h.controller.start()
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, Date.now())
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    // The armed wake-up fires and its config read fails, so neither the detach
    // nor the RE-ARM happens: the device is now pinned with no timer behind it.
    h.failNextConfigLoad()
    await vi.advanceTimersByTimeAsync(POST_MS + 1)
    await settle()
    expect(h.releaseStreamWithCodec).not.toHaveBeenCalled()
    expect(
      h.logs.some(
        (l) => l.msg.includes('scheduled re-evaluation failed') && l.tags.deviceId === DEVICE_ID,
      ),
    ).toBe(true)

    // Nothing else can save it. The reconcile does. Wait for the detach to
    // LAND (D58 / settle.ts) — a fixed drain lost this under CI load once
    // already (`expected spy called 1 times, got 0`).
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settleUntil(
      () => h.releaseStreamWithCodec.mock.calls.length >= 1,
      'reconcile detach after a lost wake-up',
    )

    await h.controller.stop()
  })

  it('retries an attach that failed because the broker was not ready', async () => {
    const h = makeHarness(continuousConfig(), { brokerReady: false })
    await h.controller.start()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    h.setBrokerReady(true)
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
  })

  it('retries a failed attach on the broker-ready transition too (without waiting for the reconcile)', async () => {
    const h = makeHarness(continuousConfig(), { brokerReady: false })
    await h.controller.start()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    h.setBrokerReady(true)
    h.fireBrokerReady()
    await settle()
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
  })
})

describe('a cold broker never holds the loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spends NO broker RPC on an attach while the broker reports not-ready', async () => {
    const h = makeHarness(continuousConfig(), { brokerReady: false })
    await h.controller.start()
    // Neither leg of the attach chain is dialled — no 20 s timeout to burn.
    expect(h.listAllProfileSlots).not.toHaveBeenCalled()
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()
    // And the dropped work is named, per device.
    expect(h.logs.some((l) => l.level === 'warn' && l.tags.deviceId === DEVICE_ID)).toBe(true)
    await h.controller.stop()
  })

  it('keeps planning placement while the RECONCILE is wedged on a slow dependency', async () => {
    // Placement is cheap (a statfs per location) but it used to ride the same
    // pass as the attach chain, and that pass is single-flighted: one reconcile
    // stuck on a broker RPC skipped every following turn, so placement stopped
    // too. On separate timers it cannot.
    const h = makeHarness(continuousConfig(), { brokerReady: false, withPlacement: true })
    await h.controller.start()

    // Wedge everything the reconcile does; the first reconcile turn now hangs
    // and every later one is skipped as "previous pass still running".
    h.blockConfigLoads()
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()
    const whileWedged = h.placementTicks.length

    // Placement keeps its own beat regardless.
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()
    expect(h.placementTicks.length).toBeGreaterThan(whileWedged)
    expect(h.placementTicks.at(-1)).toEqual([DEVICE_ID])

    await h.controller.stop()
  })
})

/**
 * The two PARAMETRIC sources (Tracks A and B).
 *
 * The point is not that windows open — motion already does that — but that a
 * band naming `person` does NOT record on a vehicle, and one naming
 * sensor 42 does NOT record on 43. With a single bucket per source both
 * would always record, silently, and the symptom would be "the class
 * filter does not work".
 */
describe('parametric sources: object detection and sensors', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const bandOn = (triggers: RecordingBand['triggers']): RecordingConfig => ({
    enabled: true,
    segmentSeconds: SEGMENT_SECONDS,
    bands: [
      {
        mode: 'events',
        days: [],
        start: '00:00',
        end: '00:00',
        triggers,
        preBufferSec: 5,
        postBufferSec: POST_BUFFER_SEC,
      },
    ],
  })

  it('a person opens the window of a band that listens to person; a vehicle does not', async () => {
    const h = makeHarness(bandOn({ objectClasses: ['person'] }))
    await h.controller.start()

    await h.controller.onTrigger(DEVICE_ID, { kind: 'object', macroClass: 'vehicle' }, Date.now())
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    await h.controller.onTrigger(DEVICE_ID, { kind: 'object', macroClass: 'person' }, Date.now())
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
  })

  it('the rising edge of a sensor named by the band attaches the camera', async () => {
    const h = makeHarness(bandOn({ sensorDeviceIds: [42] }))
    await h.controller.start()

    await h.controller.onTrigger(DEVICE_ID, { kind: 'sensor', sourceDeviceId: 42 }, Date.now())
    expect(h.getStreamWithCodec).toHaveBeenCalledTimes(1)

    await h.controller.stop()
  })

  it('a sensor NOT named by the band attaches nothing', async () => {
    const h = makeHarness(bandOn({ sensorDeviceIds: [42] }))
    await h.controller.start()

    await h.controller.onTrigger(DEVICE_ID, { kind: 'sensor', sourceDeviceId: 43 }, Date.now())
    expect(h.getStreamWithCodec).not.toHaveBeenCalled()

    await h.controller.stop()
  })
})
