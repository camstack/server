/**
 * The clip stream producer and the lane that keeps this node to one replay.
 *
 * Everything gated here is a measurement on 3836, 2026-09-23:
 *
 * - the camera granted 8 and 9 concurrent `/cam/playback` sessions on two runs
 *   and refused the next with `DESCRIBE 404` — the SAME status a bogus path
 *   and an evicted clip get, so it can never be read as an absence;
 * - two of those granted sessions answered `PLAY 200` and delivered zero RTP
 *   in four seconds, which is a branch that accepts work and produces nothing
 *   wearing a success code (D391).
 */

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import {
  type ClipStreamOutcome,
  type ClipStreamSink,
  classifyMuxFailure,
  createClipStreamProducer,
  describeCameraRefusal,
} from '../clip-stream.js'
import { buildClipStreamMuxArgs, parseClipStreamProgress } from '../clip-stream-mux.js'
import { createReplayLane } from '../replay-lane.js'

interface LoggerProbe {
  readonly logger: IScopedLogger
  readonly warns: { msg: string; data: Record<string, unknown> }[]
  readonly infos: { msg: string; data: Record<string, unknown> }[]
}

/** A logger fake — the documented type boundary a test double needs. */
function makeLogger(): LoggerProbe {
  const warns: { msg: string; data: Record<string, unknown> }[] = []
  const infos: { msg: string; data: Record<string, unknown> }[] = []
  const logger = {
    info: (msg: string, data: Record<string, unknown>) => infos.push({ msg, data }),
    warn: (msg: string, data: Record<string, unknown>) => warns.push({ msg, data }),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return { logger, warns, infos }
}

/** A `ChildProcess` stand-in with the two streams the producer drives. */
class FakeStdout extends EventEmitter {
  paused = false
  pause(): this {
    this.paused = true
    return this
  }
  resume(): this {
    this.paused = false
    return this
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStdout()
  readonly stderr = new EventEmitter()
  /** `stdio[3]` is ffmpeg's `-progress` pipe. A `read` member is what the
   *  producer narrows on, exactly as the real `Readable` has one. */
  readonly progress = Object.assign(new EventEmitter(), { read: () => null })
  readonly stdio = [null, this.stdout, this.stderr, this.progress]
  killed = false
  exitCode: number | null = null
  kill(): boolean {
    this.killed = true
    return true
  }
  /** One `-progress` block, as ffmpeg writes it. */
  report(frames: number, outTimeUs: number | 'N/A'): void {
    this.progress.emit(
      'data',
      Buffer.from(`frame=${String(frames)}\nout_time_us=${String(outTimeUs)}\nprogress=continue\n`),
    )
  }
}

interface SinkProbe {
  readonly sink: ClipStreamSink
  readonly written: Buffer[]
  begun: string | null
  ended: boolean
  /** What the producer added AFTER the body — the only channel a short serve
   *  has left, the status line being long spent. */
  trailers: Readonly<Record<string, string>> | null
  fireClose(): void
}

function makeSink(accept = true): SinkProbe {
  const written: Buffer[] = []
  let onClose: (() => void) | null = null
  const probe: SinkProbe = {
    written,
    begun: null,
    ended: false,
    trailers: null,
    fireClose: () => onClose?.(),
    sink: {
      begin: (contentType) => {
        probe.begun = contentType
      },
      write: (chunk) => {
        written.push(chunk)
        return accept
      },
      onceDrain: () => {},
      onceClose: (listener) => {
        onClose = listener
      },
      end: (trailers) => {
        probe.ended = true
        probe.trailers = trailers
      },
      destroy: () => {},
    },
  }
  return probe
}

function producerWith(child: FakeChild, logger: IScopedLogger) {
  return createClipStreamProducer({
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    logger,
    lane: createReplayLane({ logger }),
    spawnMux: () => child as unknown as ChildProcess,
    firstByteTimeoutMs: 50,
    drainTimeoutMs: 50,
  })
}

describe('the clip stream producer', () => {
  it('serves, and writes nothing to the peer before the camera has produced a byte', async () => {
    const child = new FakeChild()
    const { logger, infos } = makeLogger()
    const sink = makeSink()
    const run = producerWith(child, logger).run({
      deviceId: 3836,
      clipKey: '1-2',
      url: 'rtsp://admin:hunter2@192.168.10.80:554/cam/playback?channel=1',
      audio: 'opus',
      expectedMs: 45_000,
      sink: sink.sink,
    })
    await new Promise((r) => setImmediate(r))
    expect(sink.begun).toBeNull()
    child.stdout.emit('data', Buffer.from('ftyp'))
    expect(sink.begun).toBe('video/mp4')
    // 45 s asked for, 45.1 s delivered: the ordinary case on this camera,
    // which routinely replays a little PAST its row's window.
    child.report(560, 45_100_000)
    child.emit('close', 0)
    const outcome = await run
    expect(outcome).toEqual({
      kind: 'served',
      verdict: { kind: 'complete', expectedSeconds: 45, deliveredSeconds: 45.1 },
    })
    expect(sink.ended).toBe(true)
    // A whole clip adds nothing after its body.
    expect(sink.trailers).toEqual({})
    // Every device line carries the numeric id, and the credential never does.
    const served = infos.find((l) => l.msg.includes('was served'))
    expect(served).toBeDefined()
    expect((served?.data as { tags: { deviceId: number } } | undefined)?.tags.deviceId).toBe(3836)
    expect(JSON.stringify(served)).not.toContain('hunter2')
  })

  /**
   * The whole reason the first chunk is HELD. A camera that refuses must be a
   * clean named refusal with a status, not an empty 200 that the player shows
   * as a broken clip and nothing explains (D391).
   */
  it('refuses by NAME when the mux produces no media, and never begins the body', async () => {
    const child = new FakeChild()
    const { logger, warns } = makeLogger()
    const sink = makeSink()
    const run = producerWith(child, logger).run({
      deviceId: 3836,
      clipKey: '1-2',
      url: 'rtsp://x/y',
      audio: 'none',
      expectedMs: 45_000,
      sink: sink.sink,
    })
    await new Promise((r) => setImmediate(r))
    child.stderr.emit('data', Buffer.from('Server returned 404 Not Found'))
    child.emit('close', 1)
    const outcome = (await run) as Extract<ClipStreamOutcome, { kind: 'refused' }>
    expect(outcome.kind).toBe('refused')
    expect(outcome.code).toBe('camera-refused')
    expect(sink.begun).toBeNull()
    expect(warns.some((l) => l.msg.includes('did not complete'))).toBe(true)
  })

  it('releases the camera when a peer that stopped taking bytes never drains', async () => {
    const child = new FakeChild()
    const { logger } = makeLogger()
    const lane = createReplayLane({ logger })
    const sink = makeSink(false)
    const producer = createClipStreamProducer({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      logger,
      lane,
      spawnMux: () => child as unknown as ChildProcess,
      firstByteTimeoutMs: 5_000,
      drainTimeoutMs: 20,
    })
    const run = producer.run({
      deviceId: 3836,
      clipKey: '1-2',
      url: 'rtsp://x/y',
      audio: 'none',
      expectedMs: 45_000,
      sink: sink.sink,
    })
    await new Promise((r) => setImmediate(r))
    child.stdout.emit('data', Buffer.from('ftyp'))
    const outcome = await run
    expect(outcome).toEqual({ kind: 'cut', branch: 'peer-stalled' })
    expect(child.stdout.paused).toBe(true)
    expect(child.killed).toBe(true)
    expect(lane.held(3836)).toBe(false)
  })
})

describe('what ffmpeg’s words mean', () => {
  it('reads a status the camera returned as the CAMERA’s refusal', () => {
    expect(classifyMuxFailure('Server returned 404 Not Found')).toBe('camera-refused')
    expect(classifyMuxFailure('method SETUP failed: 401 Unauthorized')).toBe('camera-refused')
    expect(classifyMuxFailure('Connection refused')).toBe('camera-refused')
  })

  it('keeps everything else OURS rather than blaming a camera that answered', () => {
    expect(classifyMuxFailure('Unknown encoder libopus')).toBe('fetch-failed')
    expect(classifyMuxFailure('')).toBe('fetch-failed')
  })

  /**
   * D611/D315. This camera answers 404 for a path it does not serve, for a
   * recording it no longer holds AND for a session it has no budget for
   * (8–9 concurrent granted, varying with its live streams). Reporting it as
   * "this clip is gone" would tell the operator a clip which exists does not.
   */
  it('never reports a 404 as this clip being gone', () => {
    const said = describeCameraRefusal('Server returned 404 Not Found')
    // The WHOLE sentence, not a set of phrases that happen to be present.
    // A disarm that PREPENDED "this clip is gone." to the honest text left a
    // presence-only assertion green, which is a gate that cannot see the one
    // regression it exists for — the claim being ADDED rather than removed.
    expect(said.startsWith('the camera answered 404 to the replay DESCRIBE.')).toBe(true)
    expect(said).toMatch(/no budget/i)
    expect(said).toMatch(/not a claim that this clip is gone/i)
  })
})

describe('the replay lane', () => {
  it('lets one holder through and gives the slot back on release', async () => {
    const { logger } = makeLogger()
    const lane = createReplayLane({ logger, waitMs: 10 })
    const first = await lane.acquire(3836, 'stream')
    expect(first.kind).toBe('held')
    expect(lane.held(3836)).toBe(true)
    if (first.kind === 'held') first.release()
    expect(lane.held(3836)).toBe(false)
    expect((await lane.acquire(3836, 'stream')).kind).toBe('held')
  })

  /**
   * The gate, and the thing a disarm must break: a second ask must be REFUSED
   * BY NAME rather than dialling a camera this node is already holding. The
   * camera's own refusal for that is a 404 nobody can read.
   */
  it('refuses by name rather than dialling a camera it already holds', async () => {
    const { logger, warns } = makeLogger()
    const lane = createReplayLane({ logger, waitMs: 10 })
    await lane.acquire(3836, 'stream')
    const second = await lane.acquire(3836, 'stream')
    expect(second.kind).toBe('busy')
    if (second.kind === 'busy') {
      expect(second.holder).toBe('stream')
      expect(second.detail).toMatch(/replay-busy/)
      expect(second.waitedMs).toBeGreaterThanOrEqual(0)
    }
    // A refusal WE issue still gets a line, or the only evidence an operator
    // has that a clip did not play is silence (D391).
    const line = warns.find((l) => l.msg.includes('already holds one'))
    expect(line).toBeDefined()
    expect((line?.data as { tags: { deviceId: number } } | undefined)?.tags.deviceId).toBe(3836)
  })

  it('is per camera: one camera’s replay never refuses another’s', async () => {
    const { logger } = makeLogger()
    const lane = createReplayLane({ logger, waitMs: 10 })
    await lane.acquire(3836, 'stream')
    expect((await lane.acquire(1436, 'stream')).kind).toBe('held')
  })

  it('waits only for a slot that is BEING released, and takes it', async () => {
    const { logger } = makeLogger()
    const lane = createReplayLane({ logger, waitMs: 200 })
    const first = await lane.acquire(3836, 'stream')
    setTimeout(() => {
      if (first.kind === 'held') first.release()
    }, 20)
    const second = await lane.acquire(3836, 'stream')
    expect(second.kind).toBe('held')
  })
})

/**
 * D623. The camera hangs up a third of the way through a clip and ffmpeg exits
 * **0**, so for one release the only signal this producer had said `complete`.
 * Measured on 3836, 2026-09-23: 4.26 s of media and 126 video frames against a
 * 45 s row, in 9 s of wall clock — and in the operator's own log the same clip
 * was served `complete` at 4 978 237 bytes where the whole clip is 39 294 962.
 */
describe('a replay the camera cut short', () => {
  it('is NAMED, not reported complete, and says so to the peer after the body', async () => {
    const child = new FakeChild()
    const { logger, warns, infos } = makeLogger()
    const sink = makeSink()
    const run = producerWith(child, logger).run({
      deviceId: 3836,
      clipKey: '1790183010-1790183055',
      url: 'rtsp://admin:hunter2@192.168.10.80:554/cam/playback?channel=1',
      audio: 'opus',
      expectedMs: 45_000,
      sink: sink.sink,
    })
    await new Promise((r) => setImmediate(r))
    child.stdout.emit('data', Buffer.from('ftyp'))
    child.report(126, 4_260_000)
    // The exit code the camera earns for hanging up: zero.
    child.emit('close', 0)
    const outcome = await run

    expect(outcome).toEqual({
      kind: 'served',
      verdict: {
        kind: 'short',
        expectedSeconds: 45,
        deliveredSeconds: 4.26,
        shortfallSeconds: 45 - 4.26,
      },
    })
    // Never the success line, whatever ffmpeg's exit code said.
    expect(infos.some((l) => l.msg.includes('was served'))).toBe(false)
    const short = warns.find((l) => l.msg.includes('came up short against its row'))
    expect(short).toBeDefined()
    const meta = short?.data as { tags: { deviceId: number }; meta: Record<string, unknown> }
    expect(meta.tags.deviceId).toBe(3836)
    expect(meta.meta.branch).toBe('stream-short')
    expect(meta.meta.deliveredSeconds).toBe(4.26)
    expect(meta.meta.expectedMs).toBe(45_000)
    expect(meta.meta.frames).toBe(126)
    // The exit code survives beside the verdict rather than standing in for it.
    expect(meta.meta.muxExit).toBe(0)
    expect(JSON.stringify(short)).not.toContain('hunter2')

    // And it reaches the peer, on the one channel still open after a 200.
    expect(sink.trailers?.['x-camstack-reason-code']).toBe('stream-short')
    expect(sink.trailers?.['x-camstack-reason']).toContain('4.3 s of 45.0 s')
  })

  /**
   * A serve with ZERO media is not a short serve, it is nothing. The camera
   * grants the session, ffmpeg writes an `ftyp` and an empty `moov` — so the
   * producer's "did any byte arrive" gate says yes — and no picture ever
   * comes. That is diagnosed at the camera, not at the clip, and the two must
   * not share a branch (D391).
   */
  it('separates a stream that carried no media from one that came up short', async () => {
    const child = new FakeChild()
    const { logger, warns } = makeLogger()
    const sink = makeSink()
    const run = producerWith(child, logger).run({
      deviceId: 3836,
      clipKey: '1-46',
      url: 'rtsp://x/y',
      audio: 'none',
      expectedMs: 45_000,
      sink: sink.sink,
    })
    await new Promise((r) => setImmediate(r))
    child.stdout.emit('data', Buffer.from('ftypisom....moov'))
    child.report(0, 'N/A')
    child.emit('close', 0)
    const outcome = await run

    expect(outcome).toEqual({ kind: 'served', verdict: { kind: 'empty', expectedSeconds: 45 } })
    expect(warns.some((l) => l.msg.includes('came up short'))).toBe(false)
    const empty = warns.find((l) => l.msg.includes('carried no media at all'))
    // Narrowed by a throw rather than `?.`: an optional chain here would read
    // `.meta` off `undefined` when the line is missing, so the lint is right —
    // and a thrown sentence says WHICH line was absent, where a TypeError
    // would only say that something was.
    if (empty === undefined) throw new Error('no "carried no media at all" line was logged')
    expect((empty.data as { meta: Record<string, unknown> }).meta.branch).toBe('stream-empty')
    expect(sink.trailers?.['x-camstack-reason-code']).toBe('stream-empty')
  })

  /** Unknown is never folded into complete: a stream nothing measured is a
   *  stream nobody checked (D393). */
  it('says a stream could not be checked when ffmpeg reported no progress at all', async () => {
    const child = new FakeChild()
    const { logger, warns, infos } = makeLogger()
    const sink = makeSink()
    const run = producerWith(child, logger).run({
      deviceId: 3836,
      clipKey: '1-46',
      url: 'rtsp://x/y',
      audio: 'none',
      expectedMs: 45_000,
      sink: sink.sink,
    })
    await new Promise((r) => setImmediate(r))
    child.stdout.emit('data', Buffer.from('ftyp'))
    child.emit('close', 0)
    const outcome = await run

    expect(outcome).toEqual({
      kind: 'served',
      verdict: { kind: 'unknown', reason: 'duration-unmeasured' },
    })
    expect(infos.some((l) => l.msg.includes('was served'))).toBe(false)
    const unchecked = warns.find((l) => l.msg.includes('could not be checked for truncation'))
    if (unchecked === undefined) {
      throw new Error('no "could not be checked for truncation" line was logged')
    }
    expect((unchecked.data as { meta: Record<string, unknown> }).meta.branch).toBe(
      'completeness-unverified',
    )
  })
})

describe('the mux argument list', () => {
  it('asks ffmpeg for progress on a fourth pipe, never on stderr', () => {
    const args = buildClipStreamMuxArgs({ url: 'rtsp://x/y', audio: 'none' })
    const at = args.indexOf('-progress')
    expect(at).toBeGreaterThan(-1)
    // stderr is where the camera's own sentence lands and it is kept to its
    // last 4 000 characters: a progress block every half second would evict
    // the refusal before anyone read it.
    expect(args[at + 1]).toBe('pipe:3')
    expect(args).not.toContain('pipe:2')
  })

  it('reads the LAST value of each key, and never calls a zero stamp a duration', () => {
    // Measured: the first block of a live mux carries `frame=0` and
    // `out_time_us=N/A`. A parser that took the first block, or that demanded
    // both keys from one block, would report nothing on a full stream.
    expect(
      parseClipStreamProgress(
        'frame=0\nout_time_us=N/A\nprogress=continue\nframe=126\nout_time_us=4260000\nprogress=end\n',
      ),
    ).toEqual({ frames: 126, deliveredSeconds: 4.26 })
    expect(parseClipStreamProgress('frame=0\nout_time_us=0\nprogress=end\n')).toEqual({
      frames: 0,
      deliveredSeconds: null,
    })
    expect(parseClipStreamProgress('')).toEqual({ frames: null, deliveredSeconds: null })
  })
})
