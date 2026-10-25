/**
 * A TRIGGER THE BUS NEVER DELIVERED STILL PRODUCES FOOTAGE.
 *
 * `onTrigger` is an event, and an event is telemetry that may be dropped
 * (D8/D11). What it feeds is not telemetry: without a trigger window the keep
 * gate has no record that the episode happened, so the recorder never attaches
 * — or attaches and then unlinks every segment it wrote. Footage deleted is
 * gone, which is durable state, which D8 says must not rest on an event alone.
 *
 * These tests drive the controller with the bus SILENT — `onTrigger` is never
 * called once — and pin that the reconcile beat rebuilds the window from the
 * analytics store's durable motion rows and the writer spawns anyway.
 *
 * `segmentSeconds` is deliberately large so the liveness watchdog's idle bound
 * cannot fire inside the window these tests advance through.
 */
import type { RecordingConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { specRoot } from './spec-root.js'
import { settleTurns, settleUntil } from './settle.js'

/** One scratch root per RUN, not one shared path per runner. See `./spec-root.ts`. */
const SPEC_ROOT = specRoot('rec-trigger-reconcile-spec')
import {
  RECONCILE_TICK_MS,
  RecordingController,
  type RecordingControllerDeps,
} from '../recording-controller'
import { recordingsLocationOfMode } from '../roots.js'

const DEVICE_ID = 1438
const POST_BUFFER_SEC = 45
const SEGMENT_SECONDS = 600

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
  readonly loadMotionEvents: ReturnType<typeof vi.fn>
  /** Rows to answer with, resolved AT QUERY TIME so a test can be relative to `now`. */
  setMotionRows(rows: () => readonly number[]): void
  failMotionLoad(): void
}

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
        preBufferSec: 15,
        postBufferSec: POST_BUFFER_SEC,
      },
    ],
  }
}

function continuousConfig(): RecordingConfig {
  return {
    enabled: true,
    segmentSeconds: SEGMENT_SECONDS,
    bands: [{ mode: 'continuous', days: [], start: '00:00', end: '00:00' }],
  }
}

function makeHarness(initial: RecordingConfig): Harness {
  let rows: () => readonly number[] = () => []
  let failLoad = false
  const logs: LogCall[] = []
  const record =
    (level: LogCall['level'], bound: Record<string, unknown>) =>
    (
      msg: string,
      fields?: {
        meta?: Record<string, unknown>
        tags?: Record<string, unknown>
      },
    ) => {
      logs.push({
        level,
        msg,
        meta: fields?.meta ?? {},
        tags: { ...bound, ...fields?.tags },
      })
    }
  const makeLogger = (bound: Record<string, unknown>): Record<string, unknown> => ({
    info: record('info', bound),
    warn: record('warn', bound),
    error: record('warn', bound),
    debug: record('debug', bound),
    child: () => makeLogger(bound),
    withTags: (extra: Record<string, unknown>) => makeLogger({ ...bound, ...extra }),
  })

  const spawn = vi.fn(() => ({
    kill: vi.fn(),
    on: () => {},
    stderr: { on: () => {} },
  }))
  let acquireSeq = 0
  const api = {
    streamBroker: {
      getStreamWithCodec: {
        mutate: vi.fn(async () => ({
          url: 'rtsp://127.0.0.1:8554/cam1438-high',
          videoCodec: 'H265' as const,
          audioCodec: 'aac' as const,
          resolution: { width: 3840, height: 2160 },
          transcoded: false,
          encoder: 'copy',
          pipelineKey: `pk-${++acquireSeq}`,
        })),
      },
      releaseStreamWithCodec: {
        mutate: vi.fn(async () => ({ released: true, refcount: 0 })),
      },
      listAllProfileSlots: {
        query: vi.fn(async () => [
          {
            deviceId: DEVICE_ID,
            profile: 'high',
            camStreamId: 'native:main',
            status: 'streaming',
          },
        ]),
      },
    },
  } as never

  const loadMotionEvents = vi.fn(async () => {
    if (failLoad) throw new Error('analytics store unavailable')
    return rows()
  })

  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    api,
    logger: makeLogger({}) as never,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: { onFinalized: async () => null } as never,
    loadConfig: async () => initial,
    enabledDeviceIds: async () => [DEVICE_ID],
    loadMotionEvents: loadMotionEvents as never,
    locations: () => [
      recordingsLocationOfMode(
        { id: 'recordings:default', type: 'recordings', root: SPEC_ROOT },
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
    spawn,
    loadMotionEvents,
    setMotionRows: (next) => {
      rows = next
    },
    failMotionLoad: () => {
      failLoad = true
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

describe('RecordingController — the trigger reconcile', () => {
  let harness: Harness

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T14:00:00Z'))
  })

  afterEach(async () => {
    await harness.controller.stop()
    vi.useRealTimers()
  })

  /**
   * RE-ENABLED 2026-09-20. The 2026-09-14 note diagnosed this correctly — the
   * fake-timer advance raced the real `fs`/`mkdir` work in the attach chain —
   * and then drew the wrong conclusion. The cure for a race with real work is
   * to wait for the work, not to delete the test.
   */
  it('records an episode whose trigger NEVER arrived on the bus', async () => {
    harness = makeHarness(eventsConfig())
    await harness.controller.start()
    await settle()
    // Nothing recorded yet: the bus is silent and no window exists.
    expect(harness.spawn).not.toHaveBeenCalled()

    // The motion HAPPENED — the analytics store has the row. The recorder was
    // never told.
    harness.setMotionRows(() => [Date.now() - 5_000])
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settleUntil(
      () => harness.spawn.mock.calls.length >= 1,
      'the reconcile recovered the lost trigger and spawned a writer',
    )

    expect(harness.spawn).toHaveBeenCalled()
    const recovered = harness.logs.filter((l) => l.msg.includes('trigger windows recovered'))
    expect(recovered.length).toBe(1)
    expect(recovered[0]?.tags.deviceId).toBe(DEVICE_ID)
    expect(recovered[0]?.meta.recovered).toBe(1)
  })

  it('is silent and idempotent when the fast path already had the trigger', async () => {
    harness = makeHarness(eventsConfig())
    await harness.controller.start()
    const at = Date.now()
    await harness.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, at)
    await settle()
    expect(harness.spawn).toHaveBeenCalledTimes(1)

    harness.setMotionRows(() => [at])
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()

    // Same window, no second attach, and NO line claiming a recovery — a
    // reconcile that reported every row as recovered would make the log say the
    // bus was losing everything, always.
    expect(harness.logs.filter((l) => l.msg.includes('trigger windows recovered')).length).toBe(0)
  })

  /**
   * D194 amended 2026-09-28 (camera 3836): a durable row OLDER than the live
   * window by more than the post-buffer used to be APPENDED as the newest
   * window, so the live gate read a trigger from the past and tore the writer
   * down on this very beat — logged as "recovered" and "teardown drained" in
   * the same second, respawned 2–9 s later by the next keepalive.
   */
  it('a recovered row OLDER than the live window does not tear the writer down', async () => {
    harness = makeHarness(eventsConfig())
    await harness.controller.start()
    // Just before the reconcile beat, the bus opens a live episode.
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS - 10_000)
    const at = Date.now()
    await harness.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, at)
    await settleUntil(() => harness.spawn.mock.calls.length >= 1, 'the bus trigger spawned')

    // The store holds an EARLIER episode the bus never delivered, older than
    // the live one by more than the post-buffer.
    harness.setMotionRows(() => [at - (POST_BUFFER_SEC + 1) * 1000])
    await vi.advanceTimersByTimeAsync(10_000)
    await settleUntil(
      () => harness.logs.some((l) => l.msg.includes('trigger windows recovered')),
      'the reconcile beat folded the older row',
    )
    await settle()

    const recovered = harness.logs.filter((l) => l.msg.includes('trigger windows recovered'))
    expect(recovered[0]?.meta.recovered).toBe(1)
    // 10 s into a 45 s post-buffer: the writer must still be up.
    const proc = harness.spawn.mock.results[0]?.value as { kill: ReturnType<typeof vi.fn> }
    expect(proc.kill).not.toHaveBeenCalled()
    expect(harness.logs.some((l) => l.msg.includes('recording stopped'))).toBe(false)
  })

  it('asks the store NOTHING for a continuous camera — the cheap question first', async () => {
    harness = makeHarness(continuousConfig())
    await harness.controller.start()
    await settle()
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()

    expect(harness.loadMotionEvents).not.toHaveBeenCalled()
  })

  it('queries only the horizon the history can still keep anything within', async () => {
    harness = makeHarness(eventsConfig())
    await harness.controller.start()
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()

    const call = harness.loadMotionEvents.mock.calls[0]
    expect(call?.[0]).toBe(DEVICE_ID)
    // postBufferSec (45 s) + TRIGGER_HISTORY_MARGIN_MS (120 s) back from now.
    const sinceMs = call?.[1] as number
    const untilMs = call?.[2] as number
    expect(untilMs - sinceMs).toBe(POST_BUFFER_SEC * 1000 + 120_000)
  })

  it('a failing store degrades to the fast path and SAYS so — it never kills the beat', async () => {
    harness = makeHarness(eventsConfig())
    harness.failMotionLoad()
    await harness.controller.start()
    const at = Date.now()
    await harness.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, at)
    await settle()
    await vi.advanceTimersByTimeAsync(RECONCILE_TICK_MS)
    await settle()

    expect(harness.logs.some((l) => l.msg.includes('trigger reconcile failed'))).toBe(true)
    // The evaluate behind it still ran: the device is still recording.
    expect(harness.spawn).toHaveBeenCalled()
  })
})
