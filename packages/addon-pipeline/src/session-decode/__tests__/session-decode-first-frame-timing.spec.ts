/**
 * The SUCCESS-path time-to-first-decoded-frame seam.
 *
 * Until now only the FAILURE was logged (`session-decode-coordinator`'s
 * still-waiting / gave-up warns). A dial that succeeded in 8 s and a dial that
 * succeeded in 1 s produced exactly the same log output — nothing — so the
 * blind ramp between motion and the first inferenced frame could only be
 * measured by hand-correlating unrelated lines.
 *
 * The pump owns the two boundaries that matter and nothing else does: the
 * moment it began (which is when the spawn permit was requested) and the moment
 * the FIRST frame came back off the worker. It reports them once per session,
 * and the runner turns them into the one operator-facing line.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ForkedChildLike } from '../session-decode-coordinator.js'
import { startSessionDecodePump, type FirstFrameTiming } from '../session-decode-pump.js'
import type { VideoFrameSource } from '../video-frame-generator.js'
import type { WorkerReply, WorkerRequest } from '../worker-protocol.js'
import { testLease } from './test-lease-knobs.js'

interface FakeChild {
  readonly child: ForkedChildLike
  readonly emit: (reply: WorkerReply) => void
}

function createFakeChild(): FakeChild {
  const messageHandlers: Array<(m: unknown) => void> = []
  const child: ForkedChildLike = {
    send: (_msg: WorkerRequest) => {},
    on: (ev: 'message' | 'exit', cb: (m: unknown) => void) => {
      if (ev === 'message') messageHandlers.push(cb)
    },
    kill: () => {},
  }
  return {
    child,
    emit: (reply: WorkerReply) => {
      for (const h of messageHandlers) h(reply)
    },
  }
}

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const SOURCE: VideoFrameSource = { restreamUrl: 'rtsp://cam/1', deviceId: 101, codec: 'h264' }

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('session-decode pump — first-frame timing report', () => {
  it('reports the first frame exactly once, with the spawn wait split out', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const fake = createFakeChild()
      const seen: FirstFrameTiming[] = []
      let grant: (() => void) | undefined

      startSessionDecodePump({
        fork: () => fake.child,
        lease: testLease,
        hwaccel: () => null,
        logger: makeLogger(),
        source: SOURCE,
        opts: { fps: 10, format: 'rgb' },
        acquireSpawnSlot: () =>
          new Promise<() => void>((resolve) => {
            grant = () => {
              resolve(() => {})
            }
          }),
        onFirstFrame: (timing) => seen.push(timing),
        onDecodedFrame: () => {},
      })

      // 400 ms queued behind the spawn gate…
      await vi.advanceTimersByTimeAsync(400)
      if (grant !== undefined) grant()
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toHaveLength(0)

      // …then 1600 ms of fork + dial + IDR wait before the first frame.
      await vi.advanceTimersByTimeAsync(1600)
      fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 4, height: 4, format: 'rgb' })
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toHaveLength(1)
      // No `dialTiming` reply arrived, so the split is ABSENT — not zeroed. A
      // zero would read as "the demuxer opened instantly", which is a claim
      // nobody made.
      expect(seen[0]).toEqual({ spawnWaitMs: 400, forkToFrameMs: 1600 })

      // A SECOND frame must not re-report — this is a per-session line.
      fake.emit({ kind: 'frame', frameId: 2, timestamp: 2, width: 4, height: 4, format: 'rgb' })
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("carries the worker's cold-start split on the same line, without a second round-trip", async () => {
    const fake = createFakeChild()
    const seen: FirstFrameTiming[] = []

    startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source: SOURCE,
      opts: { fps: 10, format: 'rgb' },
      onFirstFrame: (timing) => seen.push(timing),
      onDecodedFrame: () => {},
    })
    await flush()

    // IPC order is the contract: the worker sends the split BEFORE the frame it
    // measured. Nothing waits for it — if it were sent after, it would simply
    // be absent, which is why this ordering is asserted rather than assumed.
    fake.emit({
      kind: 'dialTiming',
      hwContextMs: 120,
      demuxerOpenMs: 2_640,
      decoderCreateMs: 90,
      firstDecodeMs: 310,
      streamInfoProbed: true,
    })
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 4, height: 4, format: 'rgb' })
    await flush()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.dial).toEqual({
      hwContextMs: 120,
      demuxerOpenMs: 2_640,
      decoderCreateMs: 90,
      firstDecodeMs: 310,
      streamInfoProbed: true,
    })
  })

  it('reports nothing when the session ends before a first frame ever lands', async () => {
    const fake = createFakeChild()
    const seen: FirstFrameTiming[] = []
    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source: SOURCE,
      opts: { fps: 10, format: 'rgb' },
      onFirstFrame: (timing) => seen.push(timing),
      onDecodedFrame: () => {},
    })

    await flush()
    stop()
    fake.emit({ kind: 'ended' })
    await flush()

    expect(seen).toHaveLength(0)
  })
})
