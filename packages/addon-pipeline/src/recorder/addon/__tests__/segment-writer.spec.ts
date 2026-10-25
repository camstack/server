import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SegmentWriter } from '../segment-writer'
import type { PassthroughArgs } from '../ffmpeg-args'

interface FakeProc {
  readonly pid: number
  kill: ReturnType<typeof vi.fn>
  on: (ev: string, cb: (...a: unknown[]) => void) => void
  stderr: { on: () => void }
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  fireExit: (code?: number) => void
}

function makeFakeProc(pid = 4242): FakeProc {
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  const proc: FakeProc = {
    pid,
    kill: vi.fn(),
    on: (ev, cb) => {
      handlers[ev] = cb
    },
    stderr: { on: () => {} },
    // Mirrors ChildProcess: both null while running.
    exitCode: null,
    signalCode: null,
    fireExit: (code = 1) => {
      proc.exitCode = code
      handlers.exit?.(code)
    },
  }
  return proc
}

const cfg: PassthroughArgs = {
  rtspUrl: 'rtsp://x',
  outDir: '/tmp/out',
  segmentSeconds: 4,
  consumerTag: 'recorder/101/high/1',
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const RESTART_CAP_MS = 10_000
/** The camera every line this writer must be greppable by. */
const DEVICE_ID = 101

describe('SegmentWriter resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('does NOT respawn instantly — applies a backoff delay', async () => {
    const procs: FakeProc[] = []
    const spawn = vi.fn(() => {
      const p = makeFakeProc()
      procs.push(p)
      return p
    })
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
    })

    w.start()
    expect(spawn).toHaveBeenCalledTimes(1)
    procs[0]!.fireExit(1)
    // No immediate respawn (the old code restarted synchronously).
    expect(spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600) // past the 500ms base backoff
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('backoff grows per consecutive restart', async () => {
    const procs: FakeProc[] = []
    const spawn = vi.fn(() => {
      const p = makeFakeProc()
      procs.push(p)
      return p
    })
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
    })

    w.start()
    procs[0]!.fireExit() // attempt 1 → ~500ms
    await vi.advanceTimersByTimeAsync(500)
    expect(spawn).toHaveBeenCalledTimes(2)
    procs[1]!.fireExit() // attempt 2 → ~1000ms
    await vi.advanceTimersByTimeAsync(600) // not enough yet
    expect(spawn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500) // now past 1000ms
    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it('gives up after MAX consecutive rapid restarts', async () => {
    const procs: FakeProc[] = []
    const spawn = vi.fn(() => {
      const p = makeFakeProc()
      procs.push(p)
      return p
    })
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
    })

    w.start()
    // Crash rapidly 11 times; each time advance past the (capped) backoff.
    for (let i = 0; i < 11; i++) {
      procs[procs.length - 1]!.fireExit()
      await vi.advanceTimersByTimeAsync(RESTART_CAP_MS + 100)
    }
    expect(logger.warn).toHaveBeenCalledWith(
      'SegmentWriter giving up after max restarts',
      expect.anything(),
    )
    const callsAtGiveUp = spawn.mock.calls.length
    // Further time does not spawn again.
    await vi.advanceTimersByTimeAsync(RESTART_CAP_MS + 100)
    expect(spawn).toHaveBeenCalledTimes(callsAtGiveUp)
  })

  it('a stable run resets the restart counter (no give-up from sporadic blips)', async () => {
    const procs: FakeProc[] = []
    const spawn = vi.fn(() => {
      const p = makeFakeProc()
      procs.push(p)
      return p
    })
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
    })

    // Every exit now WARNS the reason, so "no give-up" is asserted on the
    // give-up messages, not on `warn` being silent.
    const gaveUp = (): boolean =>
      logger.warn.mock.calls.some((call) => String(call[0]).includes('giving up'))

    w.start()
    // 9 rapid crashes (just under MAX).
    for (let i = 0; i < 9; i++) {
      procs[procs.length - 1]!.fireExit()
      await vi.advanceTimersByTimeAsync(RESTART_CAP_MS + 100)
    }
    expect(gaveUp()).toBe(false)
    // Now a STABLE run (>30s) then a crash → counter resets, keeps restarting.
    await vi.advanceTimersByTimeAsync(31_000)
    procs[procs.length - 1]!.fireExit()
    await vi.advanceTimersByTimeAsync(600) // base backoff again (reset → attempt 1)
    expect(spawn.mock.calls.length).toBeGreaterThan(10)
    expect(gaveUp()).toBe(false)
  })

  it('stop() cancels a pending restart', async () => {
    const procs: FakeProc[] = []
    const spawn = vi.fn(() => {
      const p = makeFakeProc()
      procs.push(p)
      return p
    })
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
    })

    w.start()
    procs[0]!.fireExit()
    w.stop() // before the backoff elapses
    await vi.advanceTimersByTimeAsync(5000)
    expect(spawn).toHaveBeenCalledTimes(1) // no respawn after stop
  })

  it('stop() SIGTERMs then escalates to SIGKILL if the process ignores SIGTERM', async () => {
    const proc = makeFakeProc()
    const spawn = vi.fn(() => proc)
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
    })

    w.start()
    w.stop()
    // Immediate SIGTERM.
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(proc.kill).toHaveBeenCalledTimes(1)
    // ffmpeg stuck in an RTSP read never exits (exitCode/signalCode stay null) →
    // after the grace, an escalated SIGKILL fires (prevents the leaked-writer dup).
    await vi.advanceTimersByTimeAsync(600)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(proc.kill).toHaveBeenCalledTimes(2)
  })

  it('stop() does NOT SIGKILL when the process exits on SIGTERM within the grace', async () => {
    const proc = makeFakeProc()
    const spawn = vi.fn(() => proc)
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn,
      logger,
      deviceId: DEVICE_ID,
    })

    w.start()
    w.stop()
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    // The process exits promptly (SIGTERM landed) → exitCode set, no SIGKILL.
    proc.fireExit(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })

  it('stopAndWait resolves only after ffmpeg exits', async () => {
    const proc = makeFakeProc()
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn: () => proc,
      logger,
      deviceId: DEVICE_ID,
    })
    w.start()
    const stopped = w.stopAndWait()
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    let settled = false
    void stopped.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    proc.fireExit(0)
    await stopped
    expect(settled).toBe(true)
  })

  it('keeps the exiting child pid owned until its exit event fires', async () => {
    const proc = makeFakeProc(7001)
    const w = new SegmentWriter(cfg, {
      ffmpegPath: '/deps/ffmpeg-pinned',
      spawn: () => proc,
      logger,
      deviceId: DEVICE_ID,
    })
    w.start()
    expect(w.pid).toBe(7001)

    const stopped = w.stopAndWait()
    // `proc` has been detached from the restart path, but the staging guard
    // must still recognise it as this runner's child while SIGTERM drains it.
    expect(w.pid).toBe(7001)

    proc.fireExit(0)
    await stopped
    expect(w.pid).toBeUndefined()
  })
})
