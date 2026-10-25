/**
 * A ffmpeg that cannot be SPAWNED must not take the recorder runner down.
 *
 * ── The outage this pins (2026-08-18, 11:46 → 15:00) ──────────────────────
 * Three cameras were unplugged. Every writer for them re-dialled at once, the
 * host briefly could not fork, and `spawn()` failed with EAGAIN. In Node a
 * child that cannot be spawned emits `'error'`, and an `'error'` with NO
 * listener is re-thrown as an uncaught exception — so three transient fork
 * failures killed the `recorder` runner three times, the D6 crash
 * circuit-breaker tripped at 5 crashes in 60 s, and FLEET-WIDE recording
 * stayed dead for three hours and fifteen minutes. `/health` stayed 200
 * throughout.
 *
 * The fakes here are REAL `EventEmitter`s on purpose. A hand-rolled
 * `handlers[ev] = cb` fake (the style of `segment-writer.spec.ts`) cannot
 * reproduce the bug at all: it drops an unhandled event silently, which is the
 * one behaviour Node does not have. Emitting on an `EventEmitter` with no
 * `'error'` listener THROWS, exactly as production does, so
 * `expect(...).not.toThrow()` is the behavioural assertion that the runner
 * survives — not a check that some listener was registered.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PassthroughArgs } from '../ffmpeg-args.js'
import { SegmentWriter } from '../segment-writer.js'

/** A spawn fake with real emitter semantics — see the file docblock. */
class FakeChild extends EventEmitter {
  readonly kill = vi.fn()
  readonly stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
}

/** The errno object `child_process` attaches to a failed spawn. */
function spawnError(code: string): Error {
  const err = new Error(`spawn ffmpeg ${code}`)
  return Object.assign(err, { code, syscall: 'spawn ffmpeg', errno: -35 })
}

const cfg: PassthroughArgs = {
  rtspUrl: 'rtsp://x',
  outDir: '/tmp/out',
  segmentSeconds: 4,
  consumerTag: 'recorder/101/high/1',
}
/** The camera every line this writer must be greppable by. */
const DEVICE_ID = 101

function makeLogger(): {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  readonly error: ReturnType<typeof vi.fn>
  readonly debug: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

describe('SegmentWriter: a spawn that fails', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('EAGAIN does NOT take the process down, and a retry is scheduled', async () => {
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const logger = makeLogger()
    const writer = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
    })

    writer.start()
    expect(spawn).toHaveBeenCalledTimes(1)

    // THE ASSERTION THAT MATTERS: an unhandled 'error' is an uncaughtException,
    // which is what killed the runner. It must be handled.
    expect(() => children[0]!.emit('error', spawnError('EAGAIN'))).not.toThrow()

    // …and the SAME restart-with-backoff policy `exit` uses must run: no
    // instant respawn, then one after the base backoff.
    expect(spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(spawn).toHaveBeenCalledTimes(2)
    // A branch that drops work says so.
    expect(logger.warn).toHaveBeenCalledWith(
      'SegmentWriter ffmpeg spawn failed',
      expect.objectContaining({ meta: expect.objectContaining({ errorCode: 'EAGAIN' }) }),
    )
  })

  it('an `error` after the process already exited does not double-restart', async () => {
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const writer = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger: makeLogger(),
      deviceId: DEVICE_ID,
    })

    writer.start()
    const first = children[0]!
    first.exitCode = 1
    first.emit('exit', 1)
    // Node may emit BOTH for one child; only the first termination may drive
    // the policy or the writer respawns twice and double-writes the segment.
    expect(() => first.emit('error', spawnError('EAGAIN'))).not.toThrow()
    await vi.advanceTimersByTimeAsync(600)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('ENOENT gives up at once — ffmpeg is not installed, retrying cannot help', async () => {
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const logger = makeLogger()
    const onGaveUp = vi.fn()
    const writer = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      onGaveUp,
      deviceId: DEVICE_ID,
    })

    writer.start()
    expect(() => children[0]!.emit('error', spawnError('ENOENT'))).not.toThrow()

    // No inner respawn at all: a missing binary is not a blip, and burning the
    // 10-restart budget on it only delays the controller's recovery.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(onGaveUp).toHaveBeenCalledTimes(1)
    // Surfaced DIFFERENTLY from a transient failure: error, not warn.
    expect(logger.error).toHaveBeenCalledWith(
      'SegmentWriter giving up: ffmpeg cannot be executed on this node',
      expect.objectContaining({ meta: expect.objectContaining({ errorCode: 'ENOENT' }) }),
    )
  })

  it('a repeated EAGAIN still ends in the bounded give-up, not an infinite loop', async () => {
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const logger = makeLogger()
    const onGaveUp = vi.fn()
    const writer = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      onGaveUp,
      deviceId: DEVICE_ID,
    })

    writer.start()
    for (let i = 0; i < 11; i++) {
      children[children.length - 1]!.emit('error', spawnError('EAGAIN'))
      await vi.advanceTimersByTimeAsync(10_100)
    }
    expect(onGaveUp).toHaveBeenCalledTimes(1)
    const callsAtGiveUp = spawn.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(spawn).toHaveBeenCalledTimes(callsAtGiveUp)
  })

  it('reports resource pressure ONLY for a transient failure', () => {
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    })
    const onResourcePressure = vi.fn()
    const writer = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger: makeLogger(),
      deviceId: DEVICE_ID,
      onResourcePressure,
    })

    writer.start()
    children[0]!.emit('error', spawnError('EAGAIN'))
    expect(onResourcePressure).toHaveBeenCalledTimes(1)

    const permanent = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger: makeLogger(),
      deviceId: DEVICE_ID,
      onResourcePressure,
    })
    permanent.start()
    children[children.length - 1]!.emit('error', spawnError('ENOENT'))
    expect(onResourcePressure).toHaveBeenCalledTimes(1)
  })
})
