/**
 * A dial the source REFUSED is not a stream that ENDED (D685).
 *
 * ── What was measured (2026-09-29, hub, a hikvision runner restart) ────────
 * 21:12:34–21:13:00: 132 writer exits, `exitCode=8`, stderr `method OPTIONS
 * failed: 404 Not Found` from the local restream — 11 cameras × 2 profiles × 6
 * re-dials while the stream was not published. `restartsInWindow` reached 7 on
 * a writer whose storm budget is 15 per hour, for a camera that never went
 * away. Three provider restarts inside an hour (a deploy and two crashes) and
 * the writer "gave up: restart storm" on a healthy camera.
 *
 * The storm window exists for streams that RUN and then keep ending — the
 * shape the rapid breaker cannot see because each long run resets it. A dial
 * refused at the handshake never ran: it is already bounded by the rapid
 * (consecutive) breaker, which it still counts toward.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PassthroughArgs } from '../ffmpeg-args.js'
import { readDialRefusal } from '../dial-refusal.js'
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
  rtspUrl: 'rtsp://127.0.0.1:8554/tok/preroll-0',
  outDir: '/recordings/.rec-tmp/102/high',
  segmentSeconds: 10,
  consumerTag: 'recorder/102/high/22',
}
const DEVICE_ID = 102
/** Longer than `STABLE_RUN_MS` (30 s): a healthy recording that then ends. */
const LONG_RUN_MS = 20 * 60_000
/** `RESTART_MAX_MS` — enough to let any backoff elapse. */
const PAST_ANY_BACKOFF_MS = 10_000
/** The live stderr of a refused dial, verbatim shape. */
const REFUSED_STDERR =
  '[rtsp @ 0x7f1c2c004a40] method OPTIONS failed: 404 Not Found\n' +
  '[in#0 @ 0x7f1c2c002c80] Error opening input: Server returned 404 Not Found\n'
/** Re-dials per provider restart, as measured. */
const REFUSALS_PER_PROVIDER_RESTART = 6

function makeLogger(): {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  readonly error: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function calls(fn: ReturnType<typeof vi.fn>, message: string): readonly unknown[][] {
  return fn.mock.calls.filter((call) => call[0] === message)
}

function makeWriter(): {
  readonly w: SegmentWriter
  readonly procs: FakeProc[]
  readonly spawn: ReturnType<typeof vi.fn>
  readonly logger: ReturnType<typeof makeLogger>
  readonly onGaveUp: ReturnType<typeof vi.fn>
} {
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
  return { w, procs, spawn, logger, onGaveUp }
}

/** The current generation is refused at the handshake and exits. */
async function refuse(procs: FakeProc[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(50)
  const p = procs[procs.length - 1]!
  p.emitStderr(REFUSED_STDERR)
  p.fireExit(8)
  await vi.advanceTimersByTimeAsync(PAST_ANY_BACKOFF_MS)
}

/** One provider restart, seen from a writer: its stream ends, then 6 refusals. */
async function providerRestart(procs: FakeProc[]): Promise<void> {
  await vi.advanceTimersByTimeAsync(LONG_RUN_MS)
  procs[procs.length - 1]!.fireExit(8)
  await vi.advanceTimersByTimeAsync(PAST_ANY_BACKOFF_MS)
  for (let i = 0; i < REFUSALS_PER_PROVIDER_RESTART; i++) await refuse(procs)
}

describe('SegmentWriter: a dial the source refused', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('does not spend the storm budget — three provider restarts in an hour are not a storm', async () => {
    const { w, procs, logger, onGaveUp } = makeWriter()
    w.start()

    // 3 × (1 ended stream + 6 refusals) = 21 terminations inside one hour,
    // against a budget of 15. Only the 3 ENDED streams are restarts of a
    // stream that ran.
    for (let i = 0; i < 3; i++) await providerRestart(procs)

    expect(calls(logger.warn, 'SegmentWriter giving up: restart storm')).toHaveLength(0)
    expect(calls(logger.warn, 'SegmentWriter giving up after max restarts')).toHaveLength(0)
    expect(onGaveUp).not.toHaveBeenCalled()
    // …and it is still re-dialling: 3 ended streams + 18 refusals + the live one.
    expect(procs).toHaveLength(3 + 3 * REFUSALS_PER_PROVIDER_RESTART + 1)

    // The ended streams are still charged, and still say so.
    const exited = calls(logger.warn, 'SegmentWriter ffmpeg exited')
    expect(exited).toHaveLength(3)
    expect(exited[2]![1]).toMatchObject({ meta: { restartsInWindow: 3 } })
  })

  it('names every deferred re-dial, per camera — WARN on the first refusal of a run, INFO after', async () => {
    const { w, procs, logger } = makeWriter()
    w.start()
    await providerRestart(procs)

    const first = calls(
      logger.warn,
      'SegmentWriter dial refused — source not published, re-dialling',
    )
    const rest = calls(logger.info, 'SegmentWriter dial still refused — re-dial deferred')
    expect(first).toHaveLength(1)
    expect(rest).toHaveLength(REFUSALS_PER_PROVIDER_RESTART - 1)
    expect(first[0]![1]).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { outDir: cfg.outDir, method: 'OPTIONS', status: 404, refusedInARow: 1 },
    })
    for (const call of rest) expect(call[1]).toMatchObject({ tags: { deviceId: DEVICE_ID } })
    expect(rest[rest.length - 1]![1]).toMatchObject({
      meta: { refusedInARow: REFUSALS_PER_PROVIDER_RESTART },
    })
    // A refusal is not reported as a stream that ended.
    expect(calls(logger.warn, 'SegmentWriter ffmpeg exited')).toHaveLength(1)
  })

  it('is still bounded: consecutive refusals reach the rapid breaker and hand over to the controller', async () => {
    const { w, procs, spawn, logger, onGaveUp } = makeWriter()
    w.start()
    // A source that never comes back. MAX_RESTARTS (10) re-dials, then give up.
    for (let i = 0; i < 11; i++) await refuse(procs)

    expect(calls(logger.warn, 'SegmentWriter giving up after max restarts')).toHaveLength(1)
    expect(onGaveUp).toHaveBeenCalledTimes(1)
    const spawnsAtGiveUp = spawn.mock.calls.length
    await vi.advanceTimersByTimeAsync(LONG_RUN_MS)
    expect(spawn).toHaveBeenCalledTimes(spawnsAtGiveUp)
  })
})

describe('SegmentWriter: a SLOW refusal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('still reaches the rapid breaker when every refused dial takes longer than STABLE_RUN_MS', async () => {
    const { w, procs, spawn, logger, onGaveUp } = makeWriter()
    w.start()
    // A source that answers the handshake non-2xx only after 31 s. A refused
    // generation never ran, so its duration must not reset the breaker — and
    // since D685 it is outside the storm window too, so without this it
    // re-dials forever.
    for (let i = 0; i < 11; i++) {
      await vi.advanceTimersByTimeAsync(31_000)
      const p = procs[procs.length - 1]!
      p.emitStderr(REFUSED_STDERR)
      p.fireExit(8)
      await vi.advanceTimersByTimeAsync(PAST_ANY_BACKOFF_MS)
    }

    expect(calls(logger.warn, 'SegmentWriter giving up after max restarts')).toHaveLength(1)
    expect(onGaveUp).toHaveBeenCalledTimes(1)
    const spawnsAtGiveUp = spawn.mock.calls.length
    await vi.advanceTimersByTimeAsync(LONG_RUN_MS)
    expect(spawn).toHaveBeenCalledTimes(spawnsAtGiveUp)
  })
})

/** Camera 108, 2026-10-22: a restream that answered DESCRIBE 200 with an empty SDP. */
const EMPTY_SDP_STDERR =
  '[rtsp @ 0x7f1c2c004a40] Could not find codec parameters\n' +
  '[in#0 @ 0x7f1c2c002c80] Error opening input file rtsp://127.0.0.1:8554/tok/recording/preroll-15000.\n' +
  'Error opening input files: Invalid data found when processing input\n'

describe('SegmentWriter: an empty-SDP dial (exit 183)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('is a refusal — re-dialled without being charged to the storm window', async () => {
    const { w, procs, logger, onGaveUp } = makeWriter()
    w.start()
    // 7 fast empty-SDP exits: under the rapid breaker (10), over nothing — but
    // 16 would have tripped the 15/h storm window if each were a writer that RAN.
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(50)
      procs[procs.length - 1]!.emitStderr(EMPTY_SDP_STDERR)
      procs[procs.length - 1]!.fireExit(183)
      await vi.advanceTimersByTimeAsync(PAST_ANY_BACKOFF_MS)
    }
    expect(calls(logger.warn, 'SegmentWriter ffmpeg exited')).toHaveLength(0)
    expect(
      calls(logger.warn, 'SegmentWriter dial refused — source not published, re-dialling'),
    ).toHaveLength(1)
    expect(onGaveUp).not.toHaveBeenCalled()
  })
})

describe('readDialRefusal', () => {
  it('names an empty-SDP dial (invalid data at open) as a DESCRIBE refusal', () => {
    expect(readDialRefusal(EMPTY_SDP_STDERR.trim().split('\n'))).toEqual({
      method: 'DESCRIBE',
      status: 503,
    })
  })

  it('reads the handshake method and the status the source answered', () => {
    expect(readDialRefusal(REFUSED_STDERR.trim().split('\n'))).toEqual({
      method: 'OPTIONS',
      status: 404,
    })
    expect(readDialRefusal(['[rtsp @ 0x1] method DESCRIBE failed: 403 Forbidden'])).toEqual({
      method: 'DESCRIBE',
      status: 403,
    })
  })

  it('is null for a stream that RAN — a mid-run keepalive failure or a reset is not a refusal', () => {
    expect(
      readDialRefusal(['[rtsp @ 0x1] method GET_PARAMETER failed: 454 Session Not Found']),
    ).toBeNull()
    expect(readDialRefusal(['frame= 28 fps=2.1', 'Connection reset by peer'])).toBeNull()
    expect(readDialRefusal([])).toBeNull()
  })
})
