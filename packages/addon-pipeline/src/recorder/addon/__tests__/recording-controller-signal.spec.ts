/**
 * THE CAMERA'S OWN SIGNAL OPENS AND CLOSES THE RECORDING — and a signal the bus
 * lost still ends.
 *
 * `RecordingTriggers.deviceSignal` follows a LEVEL the camera's provider keeps
 * fresh in its `recording-signal` slice (D224). Three things must be true and
 * each is pinned here against the OBSERVABLE effect (the broker source is
 * acquired / released), never against a mock of the controller's own method:
 *
 *  1. rise → the writer attaches; fall → it detaches `postBufferSec` later,
 *     as ONE episode however long the level stayed up;
 *  2. the reconcile beat reads the slice back through RPC (D8/D11): a rise the
 *     bus never delivered still records, a fall it never delivered still
 *     stops — the latter only once TWO consecutive reads agree (D49: a read
 *     that ends work needs a second read to agree), and a read that FAILS
 *     changes nothing;
 *  3. a hold nobody has re-confirmed for {@link SIGNAL_HOLD_MAX_MS} is
 *     released with a warning — a lost event can never keep a camera pinned
 *     for ever.
 */
import type { RecordingConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { specRoot } from './spec-root.js'
import { settleTurns, settleUntil } from './settle.js'

/** One scratch root per RUN, not one shared path per runner. See `./spec-root.ts`. */
const SPEC_ROOT = specRoot('rec-signal-spec')
import {
  RECONCILE_TICK_MS,
  RecordingController,
  type RecordingControllerDeps,
  SIGNAL_HOLD_MAX_MS,
} from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'

const DEVICE_ID = 4374
const POST_BUFFER_SEC = 30
/**
 * Large on purpose: the liveness watchdog recovers a writer that produced no
 * segment for 3 × segmentSeconds, and this harness never produces one. The
 * bound test advances past SIGNAL_HOLD_MAX_MS (4 h), so the idle bound must
 * sit beyond it (3 h × 3 = 9 h) or the watchdog's re-attach would be counted
 * as the release under test.
 */
const SEGMENT_SECONDS = 3 * 3_600

interface LogCall {
  readonly level: 'info' | 'warn' | 'debug'
  readonly msg: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface SignalRead {
  readonly active: boolean
  readonly lastChangedAt: number
}

interface Harness {
  readonly controller: RecordingController
  readonly logs: LogCall[]
  readonly acquire: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
  readonly loadDeviceSignal: ReturnType<typeof vi.fn>
  /** What the RPC read answers, resolved at read time. `null` = the read fails. */
  setSignalRead(next: () => SignalRead | null): void
}

/**
 * The D380 shape: the MODE, no bands. `POST_BUFFER_SEC` and the pre-buffer
 * below are `DEVICE_DECISION_BAND`'s own pad — the mode carries no per-camera
 * buffers, so a test that named its own would be testing a band this config
 * cannot have.
 */
function signalConfig(): RecordingConfig {
  return {
    enabled: true,
    segmentSeconds: SEGMENT_SECONDS,
    bands: [],
    deviceDecision: true,
  }
}

function motionOnlyConfig(): RecordingConfig {
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
        postBufferSec: POST_BUFFER_SEC,
      },
    ],
  }
}

function makeHarness(config: RecordingConfig): Harness {
  let read: () => SignalRead | null = () => ({ active: false, lastChangedAt: 0 })
  const logs: LogCall[] = []
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
  const spawn = vi.fn(() => ({ kill: vi.fn(), on: () => {}, stderr: { on: () => {} } }))
  let acquireSeq = 0
  const acquire = vi.fn(async () => ({
    url: 'rtsp://127.0.0.1:8554/cam4374-low',
    videoCodec: 'H264' as const,
    audioCodec: 'aac' as const,
    resolution: { width: 1280, height: 720 },
    transcoded: false,
    encoder: 'copy',
    pipelineKey: `pk-${++acquireSeq}`,
  }))
  const release = vi.fn(async () => ({ released: true, refcount: 0 }))
  const api = {
    streamBroker: {
      getStreamWithCodec: { mutate: acquire },
      releaseStreamWithCodec: { mutate: release },
      listAllProfileSlots: {
        query: vi.fn(async () => [
          { deviceId: DEVICE_ID, profile: 'low', camStreamId: 'live', status: 'idle' },
        ]),
      },
    },
  } as never
  const loadDeviceSignal = vi.fn(async () => {
    const answer = read()
    if (answer === null) throw new Error('device-state unavailable')
    return answer
  })
  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    api,
    logger: makeLogger({}) as never,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: { onFinalized: async () => null } as never,
    loadConfig: async () => config,
    enabledDeviceIds: async () => [DEVICE_ID],
    loadDeviceSignal: loadDeviceSignal as never,
    locations: () => [
      recordingsLocationOfMode(
        { id: 'recordingsLow:default', type: 'recordingsLow', root: SPEC_ROOT },
        'active',
      ),
    ],
    spawn: spawn as never,
    segmentSeconds: SEGMENT_SECONDS,
    watchIntervalMs: 3_600_000,
    onBrokerReady: () => () => {},
    brokerCall: (fn) => fn(),
    brokerReady: () => true,
  }
  return {
    controller: new RecordingController(deps),
    logs,
    acquire,
    release,
    loadDeviceSignal,
    setSignalRead: (next) => {
      read = next
    },
  }
}

/**
 * ONLY before an assertion that something did NOT happen — a counted drain
 * cannot make an absence false, and it CAN run out before real filesystem work
 * has landed. Before a positive assertion, name what you are waiting for with
 * `settleUntil`. See `./settle.ts`.
 */
async function settle(): Promise<void> {
  await settleTurns()
}

/**
 * The rise's attach has LANDED: `active` holds the writer, so a later release
 * — by a fall, by two agreeing reads, by the bound — has something to detach.
 *
 * The attach does real filesystem work (the staging `mkdir`) after the rise
 * returns, and the reconcile that must end the hold evaluates against `active`.
 * A counted drain before a 4 h fake advance was a bet that the mkdir lands
 * before the tick that crosses the bound; `expected "spy" to be called 1 times,
 * but got 0 times` on 2026-09-23 (CI run 35895968547) is what losing it looks
 * like — the bound fired, found nothing pinned, and the attach that landed
 * afterwards had nothing left to close it.
 */
async function settleAttached(h: Harness): Promise<void> {
  await settleUntil(
    () => h.logs.some((l) => l.msg.includes('recorder pinned broker source(s) for recording')),
    'the signal rise pinned the broker source',
  )
}

const SIGNAL = { kind: 'signal' } as const

describe('RecordingController — the device signal', () => {
  let h: Harness

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T10:00:00Z'))
  })

  afterEach(async () => {
    await h.controller.stop()
    vi.useRealTimers()
  })

  /**
   * RE-ENABLED 2026-09-20. Commented out on 2026-09-14 as a "load lottery".
   * It was: `settle()` counted turns against real filesystem work in the
   * attach/detach chain, so whichever test happened to be running when the
   * machine was busiest lost. The count is gone.
   */
  it('rise attaches, fall detaches postBufferSec later — one episode however long', async () => {
    h = makeHarness(signalConfig())
    await h.controller.start()
    await settle()
    expect(h.acquire).not.toHaveBeenCalled()

    await h.controller.onSignalLevel(DEVICE_ID, SIGNAL, true, Date.now())
    // The slice agrees with the event, as it does on a real cleaning: the
    // reconcile reads it every beat and a slice saying "down" would (after two
    // reads) release the hold — the right behaviour, and not this test.
    h.setSignalRead(() => ({ active: true, lastChangedAt: Date.now() }))
    await settleUntil(() => h.acquire.mock.calls.length >= 1, 'the signal rise attached the device')
    expect(h.acquire).toHaveBeenCalledTimes(1)

    // Forty minutes in: still ONE attach, nothing released — no window-close
    // timer fired, because a held level has no close instant.
    await vi.advanceTimersByTimeAsync(40 * 60_000)
    await settle()
    expect(h.acquire).toHaveBeenCalledTimes(1)
    expect(h.release).not.toHaveBeenCalled()

    h.setSignalRead(() => ({ active: false, lastChangedAt: Date.now() }))
    await h.controller.onSignalLevel(DEVICE_ID, SIGNAL, false, Date.now())
    await settle()
    // Post-buffer still running.
    await vi.advanceTimersByTimeAsync(POST_BUFFER_SEC * 1000 - 1_000)
    await settle()
    expect(h.release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    await settleUntil(
      () => h.release.mock.calls.length >= 1,
      'the post-buffer expired and the source was released',
    )
    expect(h.release).toHaveBeenCalledTimes(1)
    const opened = h.logs.filter((l) => l.msg.includes('device signal raised'))
    expect(opened[0]?.tags.deviceId).toBe(DEVICE_ID)
  })

  it('a band that does not listen to the signal ignores it', async () => {
    h = makeHarness(motionOnlyConfig())
    await h.controller.start()
    await h.controller.onSignalLevel(DEVICE_ID, SIGNAL, true, Date.now())
    await settle()
    expect(h.acquire).not.toHaveBeenCalled()
  })

  it('a rise the bus never delivered is recovered by the reconcile read', async () => {
    h = makeHarness(signalConfig())
    await h.controller.start()
    await settle()
    h.setSignalRead(() => ({ active: true, lastChangedAt: Date.now() - 5_000 }))
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()
    expect(h.acquire).toHaveBeenCalledTimes(1)
    const recovered = h.logs.filter((l) => l.msg.includes('device signal recovered'))
    expect(recovered.length).toBe(1)
    expect(recovered[0]?.tags.deviceId).toBe(DEVICE_ID)
  })

  it('a fall the bus never delivered is applied only when TWO reads agree, then the post-buffer runs', async () => {
    h = makeHarness(signalConfig())
    await h.controller.start()
    await h.controller.onSignalLevel(DEVICE_ID, SIGNAL, true, Date.now())
    await settleAttached(h)
    expect(h.acquire).toHaveBeenCalledTimes(1)

    h.setSignalRead(() => ({ active: false, lastChangedAt: Date.now() }))
    // First contradicting read: still held.
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()
    await vi.advanceTimersByTimeAsync(POST_BUFFER_SEC * 1000 + 2_000)
    await settle()
    expect(h.release).not.toHaveBeenCalled()
    // Second: released, and the post-buffer closes the window.
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()
    await vi.advanceTimersByTimeAsync(POST_BUFFER_SEC * 1000 + 2_000)
    await settleUntil(
      () => h.release.mock.calls.length >= 1,
      'two agreeing reads released the hold and the post-buffer closed the window',
    )
    expect(h.release).toHaveBeenCalledTimes(1)
    const released = h.logs.filter((l) => l.msg.includes('device signal released by reconcile'))
    expect(released[0]?.tags.deviceId).toBe(DEVICE_ID)
  })

  it('a read that FAILS changes nothing — the hold stands', async () => {
    h = makeHarness(signalConfig())
    await h.controller.start()
    await h.controller.onSignalLevel(DEVICE_ID, SIGNAL, true, Date.now())
    await settleAttached(h)
    h.setSignalRead(() => null)
    await vi.advanceTimersByTimeAsync(3 * RECONCILE_TICK_MS)
    await settle()
    expect(h.release).not.toHaveBeenCalled()
    expect(h.loadDeviceSignal).toHaveBeenCalled()
  })

  it('a hold nobody re-confirms for SIGNAL_HOLD_MAX_MS is released with a warning', async () => {
    h = makeHarness(signalConfig())
    await h.controller.start()
    await h.controller.onSignalLevel(DEVICE_ID, SIGNAL, true, Date.now())
    await settleAttached(h)
    h.setSignalRead(() => null)
    await vi.advanceTimersByTimeAsync(SIGNAL_HOLD_MAX_MS + RECONCILE_TICK_MS)
    await settle()
    await vi.advanceTimersByTimeAsync(POST_BUFFER_SEC * 1000 + 2_000)
    await settleUntil(
      () => h.release.mock.calls.length >= 1,
      'the bound released the hold and the post-buffer closed the window',
    )
    expect(h.release).toHaveBeenCalledTimes(1)
    const bounded = h.logs.filter(
      (l) => l.level === 'warn' && l.msg.includes('device signal held past its bound'),
    )
    expect(bounded.length).toBe(1)
    expect(bounded[0]?.tags.deviceId).toBe(DEVICE_ID)
  })

  it('a re-confirmed hold is NOT bounded: the bound counts from the last read that said active', async () => {
    h = makeHarness(signalConfig())
    await h.controller.start()
    await h.controller.onSignalLevel(DEVICE_ID, SIGNAL, true, Date.now())
    await settleAttached(h)
    h.setSignalRead(() => ({ active: true, lastChangedAt: Date.now() }))
    await vi.advanceTimersByTimeAsync(SIGNAL_HOLD_MAX_MS + RECONCILE_TICK_MS)
    await settle()
    expect(h.release).not.toHaveBeenCalled()
  })
})
