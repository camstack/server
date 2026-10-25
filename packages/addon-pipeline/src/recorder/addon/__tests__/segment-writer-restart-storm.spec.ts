/**
 * The storm nobody could see, and the reason nobody could read.
 *
 * ── What was measured (2026-08-27, 12 h on the live hub) ──────────────────
 * `SegmentWriter restarting` fired **1 814 times**, every one of them with
 * `reason=exit`. Four consecutive real `ranMs` samples: 122 620, 165 255,
 * 345 420, 394 522 ms. All of them well over `STABLE_RUN_MS` (30 000), so:
 *
 *   - the consecutive-restart counter was reset on EVERY termination,
 *   - `attempt` never left 1,
 *   - `MAX_RESTARTS` was never reached, `onGaveUp` never fired, and
 *     `recoverWriterGaveUp` never ran — the storm was invisible to the
 *     controller and could have run forever;
 *   - and the exit branch — the ONLY branch that was firing — logged nothing
 *     at all, so `exitCode` and the stderr tail were captured on every spawn
 *     and thrown away 1 814 times.
 *
 * Both tests below reproduce that exact shape: a long-run storm, `ranMs` above
 * the stable threshold every time. Under the old policy neither could fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PassthroughArgs } from '../ffmpeg-args.js'
import { SegmentWriter } from '../segment-writer.js'

interface FakeProc {
  readonly kill: ReturnType<typeof vi.fn>
  readonly on: (ev: string, cb: (...a: unknown[]) => void) => void
  readonly stderr: { readonly on: (ev: string, cb: (...a: unknown[]) => void) => void }
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  readonly emitStderr: (text: string) => void
  readonly fireExit: (code: number | null, signal?: string) => void
}

function makeFakeProc(): FakeProc {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  const stderrHandlers = new Map<string, (...a: unknown[]) => void>()
  const proc: FakeProc = {
    kill: vi.fn(),
    on: (ev, cb) => {
      handlers.set(ev, cb)
    },
    stderr: {
      on: (ev, cb) => {
        stderrHandlers.set(ev, cb)
      },
    },
    exitCode: null,
    signalCode: null,
    emitStderr: (text) => stderrHandlers.get('data')?.(Buffer.from(text, 'utf8')),
    fireExit: (code, signal) => {
      proc.exitCode = code
      handlers.get('exit')?.(code, signal)
    },
  }
  return proc
}

const cfg: PassthroughArgs = {
  rtspUrl: 'rtsp://x',
  outDir: '/recordings/.rec-tmp/101/high',
  segmentSeconds: 4,
  consumerTag: 'recorder/101/high/177',
}
/** The camera. Every line about it must be greppable by this number. */
const DEVICE_ID = 101
/** `STABLE_RUN_MS` is 30 s — every run here is deliberately LONGER. */
const LONG_RUN_MS = 120_000
/** `MAX_RESTARTS_IN_WINDOW` in `segment-writer.ts`. */
const WINDOW_BUDGET = 15

function makeLogger(): {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  readonly error: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** Calls to `warn` whose message is `message`. */
function warnCalls(
  logger: { readonly warn: ReturnType<typeof vi.fn> },
  message: string,
): readonly unknown[][] {
  return logger.warn.mock.calls.filter((call) => call[0] === message)
}

describe('SegmentWriter: a storm of LONG runs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('says WHY ffmpeg exited — code, signal, ranMs and the stderr tail, tagged by camera', async () => {
    const procs: FakeProc[] = []
    const spawn = vi.fn(() => {
      const p = makeFakeProc()
      procs.push(p)
      return p
    })
    const logger = makeLogger()
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
    })

    w.start()
    procs[0]!.emitStderr('[rtsp @ 0x1] method DESCRIBE failed\nConnection reset by peer\n')
    // A long, healthy-looking run — the shape that produced no line at all.
    await vi.advanceTimersByTimeAsync(LONG_RUN_MS)
    procs[0]!.fireExit(null, 'SIGKILL')

    const calls = warnCalls(logger, 'SegmentWriter ffmpeg exited')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toMatchObject({
      // The rule this repo paid a 22 % thumbnail gap and a 3 h blackout for.
      tags: { deviceId: DEVICE_ID },
      meta: {
        outDir: cfg.outDir,
        exitCode: null,
        // `exitCode: null` alone is ambiguous; the signal is what disambiguates.
        signal: 'SIGKILL',
        ranMs: LONG_RUN_MS,
        stderrTail: '[rtsp @ 0x1] method DESCRIBE failed | Connection reset by peer',
      },
    })
  })

  it('detects a storm whose every run is LONGER than STABLE_RUN_MS (attempt stays 1, onGaveUp still fires)', async () => {
    const procs: FakeProc[] = []
    const spawn = vi.fn(() => {
      const p = makeFakeProc()
      procs.push(p)
      return p
    })
    const logger = makeLogger()
    const onGaveUp = vi.fn()
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
      onGaveUp,
    })

    w.start()
    // The live shape: 1441/high restarted 549 times in 12 h, each run minutes
    // long. Every iteration resets the consecutive counter by construction.
    for (let i = 0; i < WINDOW_BUDGET; i++) {
      await vi.advanceTimersByTimeAsync(LONG_RUN_MS)
      procs[procs.length - 1]!.fireExit(1)
      await vi.advanceTimersByTimeAsync(1_000) // past the (reset) base backoff
    }

    // The lie that hid it: the consecutive counter never got above 1.
    const restarting = logger.info.mock.calls.filter(
      (call) => call[0] === 'SegmentWriter restarting',
    )
    expect(restarting).not.toHaveLength(0)
    for (const call of restarting) {
      expect(call[1]).toMatchObject({ meta: { attempt: 1 } })
    }
    // …and the rapid breaker, which is the only one that existed, never fired.
    expect(warnCalls(logger, 'SegmentWriter giving up after max restarts')).toHaveLength(0)

    // What is new: the window counted every one of them anyway.
    const storm = warnCalls(logger, 'SegmentWriter giving up: restart storm')
    expect(storm).toHaveLength(1)
    expect(storm[0]![1]).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      // ZERO — the consecutive counter had just been reset by the long run,
      // for the fifteenth time. This is the number the old policy gated on.
      meta: { restartsInWindow: WINDOW_BUDGET, budget: WINDOW_BUDGET, attempt: 0 },
    })
    // The controller finally hears about it.
    expect(onGaveUp).toHaveBeenCalledTimes(1)

    // And it STOPS respawning — a give-up that keeps spawning is not one.
    const callsAtGiveUp = spawn.mock.calls.length
    await vi.advanceTimersByTimeAsync(LONG_RUN_MS)
    expect(spawn).toHaveBeenCalledTimes(callsAtGiveUp)
  })

  it('does not trip on a writer that restarts a few times an hour', async () => {
    const procs: FakeProc[] = []
    const spawn = vi.fn(() => {
      const p = makeFakeProc()
      procs.push(p)
      return p
    })
    const logger = makeLogger()
    const onGaveUp = vi.fn()
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
      onGaveUp,
    })

    w.start()
    // The healthy shape measured on the same day: `low` profiles at 4–15
    // restarts per TWELVE hours. Here, one restart every 20 minutes for four
    // hours — 12 restarts, none of them ever inside one window with 14 others.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      procs[procs.length - 1]!.fireExit(1)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(warnCalls(logger, 'SegmentWriter giving up: restart storm')).toHaveLength(0)
    expect(onGaveUp).not.toHaveBeenCalled()
  })
})
