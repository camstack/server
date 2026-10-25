/**
 * RecordingController: the RECOVERY path must stay bounded and per-device.
 *
 * 2026-08-13, hub, devices 104/101/102/1441. The recorder went silent for 9–27
 * minutes at a time (04:44:33Z → 05:11:22Z, and repeatedly through the night)
 * and produced the real recording gaps behind the 80% timelapse coverage. The
 * event loop was NOT blocked — the hourly retention sweep kept firing to the
 * millisecond across the whole window (3600.001 s between 04:44:33.261 and
 * 05:44:33.262). What wedged was the CONVERGENCE PASS:
 *
 *   tick → checkIdleWriters → for (device of stalled) await recoverWriterGaveUp
 *        → detachDevice (device leaves `active`, recording STOPS)
 *        → evaluateDevice → performAttach → listAllProfileSlots / getStreamWithCodec
 *
 * Those two broker RPCs were unbounded: `CapabilityHandle.call` gates readiness
 * (10 s) and then returns `fn()` untouched, so each fell through to the 60 s UDS
 * default. With the broker degraded (516 UDS timeouts that day) one device cost
 * up to 4 × 60 s, and the fan-out was SERIAL — four devices ≈ 16 minutes in one
 * tick. For that whole window every device sat detached (not in `active`, so
 * `checkIdleWriters` had nothing to report) and in `attaching` (so
 * `evaluateDevice` returned early). Recording stopped and not one line was
 * logged: `idleMs=546335` against `boundMs=90000` is the watchdog reporting a
 * 9-minute-late first look.
 *
 * These tests pin the three properties that were missing:
 *   1. an attach RPC is abandoned under a bound and the deferral is NAMED;
 *   2. one wedged device never blocks another device's recovery;
 *   3. the liveness watchdog keeps its cadence even while convergence is stuck.
 */

import type { RecordingConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { specRoot } from './spec-root.js'

/** One scratch root per RUN, not one shared path per runner. See `./spec-root.ts`. */
const SPEC_ROOT = specRoot('rec-stall-bound-spec')
import {
  RECONCILE_TICK_MS,
  RecordingController,
  type RecordingControllerDeps,
} from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'

interface FakeProc {
  kill: ReturnType<typeof vi.fn>
  on: (ev: string, cb: (...a: unknown[]) => void) => void
  stderr: { on: () => void }
}

function makeFakeProc(): FakeProc {
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  return {
    kill: vi.fn(),
    on: (ev, cb) => {
      handlers[ev] = cb
    },
    stderr: { on: () => {} },
  }
}

interface CapturedLine {
  readonly message: string
  readonly deviceId?: number
  readonly meta?: Record<string, unknown>
}

const DISABLED_CONFIG: RecordingConfig = { enabled: false, bands: [] }

const CONTINUOUS_CONFIG: RecordingConfig = {
  enabled: true,
  bands: [{ mode: 'continuous', days: [], start: '00:00', end: '00:00' }],
}

interface HarnessOptions {
  /** Devices the controller should record. */
  readonly deviceIds?: readonly number[]
  /** Devices whose SECOND (recovery) acquire never settles. */
  readonly hangReacquireFor?: readonly number[]
  /** Devices whose recording config is `enabled: false` (never attached). */
  readonly disabledDeviceIds?: readonly number[]
}

interface Harness {
  readonly controller: RecordingController
  readonly acquiresFor: (deviceId: number) => number
  readonly warns: CapturedLine[]
  readonly advanceClock: (ms: number) => void
  /**
   * From now on every config read never settles. `loadConfig` is the first
   * await of `evaluateDevice` and nothing bounds it, so a pass that reaches it
   * is wedged for as long as the test says — not for as long as the real
   * filesystem under the attach happens to take.
   */
  readonly wedgeConfigReads: () => void
  /** The same, for ONE device: every other device's reads still answer. */
  readonly wedgeConfigReadsFor: (deviceId: number) => void
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const deviceIds = opts.deviceIds ?? [99]
  const hangReacquire = new Set(opts.hangReacquireFor ?? [])

  const spawn = vi.fn(() => makeFakeProc())

  const acquires = new Map<number, number>()
  let acquireSeq = 0
  const getStreamWithCodec = vi.fn(async (input: { deviceId: number }) => {
    const n = (acquires.get(input.deviceId) ?? 0) + 1
    acquires.set(input.deviceId, n)
    // The re-acquire during recovery is the call that hung in production.
    if (n > 1 && hangReacquire.has(input.deviceId)) return new Promise<never>(() => {})
    return {
      url: `rtsp://127.0.0.1:8554/cam${input.deviceId}-sub`,
      videoCodec: 'H265' as const,
      audioCodec: 'aac' as const,
      resolution: { width: 1280, height: 720 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: `pk-${++acquireSeq}`,
    }
  })
  const releaseStreamWithCodec = vi.fn(async () => ({ released: true, refcount: 0 }))

  const warns: CapturedLine[] = []
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
        query: async () =>
          deviceIds.map((deviceId) => ({
            deviceId,
            profile: 'sub',
            camStreamId: 'native:sub',
            status: 'streaming',
          })),
      },
    },
  } as never

  let clock = 1_800_000_000_000
  let configWedged = false
  const wedgedDevices = new Set<number>()
  const disabled = new Set(opts.disabledDeviceIds ?? [])

  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    api,
    logger,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: { onFinalized: vi.fn(async () => null) } as never,
    loadConfig: async (deviceId: number) => {
      if (configWedged || wedgedDevices.has(deviceId)) return new Promise<never>(() => {})
      return disabled.has(deviceId) ? DISABLED_CONFIG : CONTINUOUS_CONFIG
    },
    enabledDeviceIds: async () => deviceIds,
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
    now: () => clock,
  }

  return {
    controller: new RecordingController(deps),
    acquiresFor: (deviceId: number) => acquires.get(deviceId) ?? 0,
    warns,
    advanceClock: (ms: number) => {
      clock += ms
    },
    wedgeConfigReads: () => {
      configWedged = true
    },
    wedgeConfigReadsFor: (deviceId: number) => {
      wedgedDevices.add(deviceId)
    },
  }
}

/**
 * Age the writers past their idle bound WITHOUT firing a timer, then run
 * exactly ONE pass. Advancing wall clock and timers together fires ten ticks
 * over five minutes, and a pile-up of overlapping passes can make a serial
 * fan-out look parallel — device N+1 simply gets recovered by a LATER tick.
 * The property under test is what ONE pass achieves.
 */
async function ageThenOnePass(
  h: Harness,
  idleMs: number,
  passMs: number = LIVENESS_PASS_MS,
): Promise<void> {
  h.advanceClock(idleMs)
  await vi.advanceTimersByTimeAsync(passMs)
  await drain()
}

/**
 * Let an in-flight pass settle. The attach chain and its rollback touch the
 * real filesystem (`mkdir` of the staging dir, the watcher's final playlist
 * read), which needs event-loop turns rather than just a microtask flush.
 * Advances timer time only negligibly, so it never crosses a pass boundary.
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(1)
}

/**
 * Turn the event loop until `done()` holds, one fake millisecond per turn.
 *
 * `drain()`'s fixed 50 turns is a guess at how long the REAL filesystem under a
 * detach/attach takes, and on a loaded machine it guessed short: the recovery
 * attach had not reached `getStreamWithCodec` yet and `acquiresFor(99)` read 1
 * (1 run in 30). Waiting for the fact the assertion is about removes the guess.
 * The cap only turns a genuine hang into a readable failure; at 1 ms per turn
 * it stays far below every bound these tests measure (20 s attach, 30 s pass).
 */
async function settle(done: () => boolean, maxTurns = 2_000): Promise<void> {
  for (let i = 0; i < maxTurns && !done(); i++) await vi.advanceTimersByTimeAsync(1)
}

/** The liveness watchdog's cadence — the beat every test here ages against. */
const LIVENESS_PASS_MS = 30_000

/** Comfortably past the controller's per-RPC attach bound. */
const ATTACH_BOUND_MS = 25_000

describe('RecordingController — recovery stays bounded and per-device', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('abandons a hung broker acquire under a bound and names the deferral', async () => {
    const h = makeHarness({ deviceIds: [99], hangReacquireFor: [99] })
    await h.controller.start()
    expect(h.acquiresFor(99)).toBe(1)

    // Five minutes of no finalized segment → the watchdog detaches and
    // re-attaches; that second acquire never settles.
    await ageThenOnePass(h, 5 * 60_000)
    await settle(() => h.acquiresFor(99) >= 2)
    expect(h.acquiresFor(99)).toBe(2)
    // Still inside the bound: nothing has been given up on yet.
    expect(h.warns.some((w) => /timed out after/i.test(String(w.meta?.['error'] ?? '')))).toBe(
      false,
    )

    // Past the attach bound, still far below the 60 s UDS default the call used
    // to inherit. The attach must be abandoned — and NAMED, with the deviceId.
    await vi.advanceTimersByTimeAsync(ATTACH_BOUND_MS)
    await settle(() =>
      h.warns.some((w) => /timed out after/i.test(String(w.meta?.['error'] ?? ''))),
    )

    // The bound must show up as an ABANDONED attach attributable to the camera:
    // the error names the RPC and its bound, and the line carries the deviceId.
    const deferred = h.warns.find((w) => /timed out after/i.test(String(w.meta?.['error'] ?? '')))
    expect(deferred).toBeDefined()
    expect(deferred!.deviceId).toBe(99)
    expect(String(deferred!.meta?.['error'])).toMatch(/getStreamWithCodec timed out after 20000ms/)

    await h.controller.stop()
  })

  it('does not let one wedged device block another device recovery', async () => {
    const h = makeHarness({ deviceIds: [99, 100], hangReacquireFor: [99] })
    await h.controller.start()
    expect(h.acquiresFor(99)).toBe(1)
    expect(h.acquiresFor(100)).toBe(1)

    // Both stall. 99's re-acquire hangs forever; 100 must still be re-pinned in
    // the SAME pass — serially awaiting 99 is what cost 16 minutes of footage.
    await ageThenOnePass(h, 5 * 60_000)
    await settle(() => h.acquiresFor(99) >= 2 && h.acquiresFor(100) > 1)

    expect(h.acquiresFor(99)).toBe(2)
    expect(h.acquiresFor(100)).toBeGreaterThan(1)

    await h.controller.stop()
  })

  it('keeps the liveness watchdog on cadence while a convergence pass is stuck', async () => {
    // 99 records; 100 is configured but disabled, so it has no writer and the
    // watchdog never looks at it — only the RECONCILE evaluates it. Wedging
    // 100's config reads therefore wedges the reconcile and nothing else. (This
    // test used to hang `enabledDeviceIds`, which the pass bounds at 5 s: it
    // never had a stuck pass at all.)
    const h = makeHarness({ deviceIds: [99, 100], disabledDeviceIds: [100] })
    await h.controller.start()
    h.wedgeConfigReadsFor(100)

    // Two reconcile beats on fake time only (the injected clock does not move,
    // so no writer is idle yet). The second fire finds the first still running.
    await vi.advanceTimersByTimeAsync(2 * RECONCILE_TICK_MS)
    await drain()
    const reconcileSkipped = (): number =>
      h.warns.filter((w) => /still running/i.test(w.message) && w.meta?.['pass'] === 'reconcile')
        .length
    expect(reconcileSkipped()).toBeGreaterThan(0)
    expect(h.warns.filter((w) => /no segment/i.test(w.message))).toHaveLength(0)

    // Now 99 goes silent. The liveness watchdog owes its cadence to nothing but
    // its own timer — a guard that waited on the stuck reconcile here would
    // reintroduce the 9-minute-late `idleMs=546335` first look.
    await ageThenOnePass(h, 5 * 60_000)
    const reported = h.warns.filter((w) => /no segment/i.test(w.message))
    expect(reported.length).toBeGreaterThan(0)
    expect(reported[0]!.deviceId).toBe(99)

    await h.controller.stop()
  })

  it('says when a pass is skipped because the previous one is still running', async () => {
    // The wedge must be one the pass does NOT bound. This test used to hang
    // `enabledDeviceIds`, which `trackedDeviceIds` has capped at 5 s since
    // TRACKED_DEVICES_READ_TIMEOUT_MS: the first reconcile un-wedged itself and
    // went on into the attach's REAL filesystem work, so whether it was still in
    // flight at the second fire was a race between real I/O and fake time — it
    // failed 16 runs in 20 on this Mac. A config read is the first await of
    // every evaluate and is unbounded, so here the pass is in flight by
    // construction.
    const h = makeHarness({ deviceIds: [99] })
    await h.controller.start()
    h.wedgeConfigReads()

    await ageThenOnePass(h, 5 * 60_000, RECONCILE_TICK_MS)
    await ageThenOnePass(h, 5 * 60_000, RECONCILE_TICK_MS)

    const skipped = h.warns.find(
      (w) => /still running|previous pass/i.test(w.message) && w.meta?.['pass'] === 'reconcile',
    )
    expect(skipped).toBeDefined()
    // Measured on the INJECTED clock, which only `ageThenOnePass`'s idle step
    // moves: the second fire is exactly one idle step after the first.
    expect(skipped!.meta?.['inFlightMs']).toBe(5 * 60_000)

    await h.controller.stop()
  })
})
