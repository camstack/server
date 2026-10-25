import { describe, it, expect, vi } from 'vitest'
import type { DecodedFrame, IScopedLogger } from '@camstack/types'
import { startSessionDecodePump } from '../session-decode-pump.js'
import type { ForkedChildLike } from '../session-decode-coordinator.js'
import type { WorkerReply, WorkerRequest } from '../worker-protocol.js'
import type { VideoFrameSource } from '../video-frame-generator.js'
import { testLease } from './test-lease-knobs.js'

/**
 * Fake `ForkedChildLike` — records every `WorkerRequest` sent and lets the
 * test script `WorkerReply` messages back (`emit`). Mirrors the fake in
 * `session-decode-coordinator.spec.ts` so the pump exercises the REAL
 * coordinator over a scripted protocol without spawning a process.
 */
function createFakeChild(): {
  child: ForkedChildLike
  sent: WorkerRequest[]
  emit: (reply: WorkerReply) => void
  kill: ReturnType<typeof vi.fn>
} {
  const sent: WorkerRequest[] = []
  const messageHandlers: Array<(m: unknown) => void> = []
  const kill = vi.fn()
  const child: ForkedChildLike = {
    send: (msg: WorkerRequest) => {
      sent.push(msg)
    },
    on: (ev: 'message' | 'exit', cb: (m: unknown) => void) => {
      if (ev === 'message') messageHandlers.push(cb)
    },
    kill,
  }
  return {
    child,
    sent,
    kill,
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

const source: VideoFrameSource = { restreamUrl: 'rtsp://cam/1', deviceId: 42, codec: 'h264' }

/** Flush the microtask queue (plus one macrotask turn) so the pump's internal
 *  async for-await loop advances between scripted replies. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('startSessionDecodePump', () => {
  it('delivers a DecodedFrame built from the scripted frame + buffer reply, then teardown stops + kills the child', async () => {
    const fake = createFakeChild()
    const logger = makeLogger()
    const delivered: DecodedFrame[] = []

    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
      source,
      opts: { fps: 10, format: 'rgb' },
      onDecodedFrame: (frame) => {
        delivered.push(frame)
      },
    })

    // Let the pump's loop send `start` + first `pull`.
    await flush()
    expect(fake.sent.some((m) => m.kind === 'start')).toBe(true)
    expect(fake.sent.some((m) => m.kind === 'pull')).toBe(true)

    // Script one decoded frame.
    fake.emit({ kind: 'frame', frameId: 5, timestamp: 999, width: 8, height: 6, format: 'rgb' })

    // The pump asks for the pixels via toBuffer.
    await flush()
    const toBufferReq = fake.sent.find((m) => m.kind === 'toBuffer')
    expect(toBufferReq).toBeDefined()
    if (!toBufferReq || toBufferReq.kind !== 'toBuffer')
      throw new Error('expected toBuffer request')
    expect(toBufferReq.frameId).toBe(5)
    // Detection reads rgb pixels.
    expect(toBufferReq.opts?.format).toBe('rgb')

    const scripted = new Uint8Array([10, 20, 30, 40])
    fake.emit({ kind: 'buffer', frameId: 5, bytes: scripted })

    // Let the pump build + deliver the DecodedFrame.
    await flush()

    expect(delivered).toHaveLength(1)
    const frame = delivered[0]!
    expect(frame.width).toBe(8)
    expect(frame.height).toBe(6)
    expect(frame.format).toBe('rgb')
    expect(frame.timestamp).toBe(999)
    expect(typeof frame.capturedAt).toBe('number')
    expect(Buffer.from(frame.data).equals(Buffer.from(scripted))).toBe(true)

    // After delivering, the pump loops into a second `pull` and suspends
    // awaiting the next frame. Teardown requests generator return; the queued
    // return runs the coordinator's `finally` (stop + kill) as soon as that
    // in-flight pull settles — here simulated by the worker's stream ending
    // (in prod: the next decoded frame, or the pull-liveness timeout).
    stop()
    await flush()
    fake.emit({ kind: 'ended' })
    await flush()
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(true)
    expect(fake.kill).toHaveBeenCalled()
  })

  it('requests gray pixels when the motion format is gray', async () => {
    const fake = createFakeChild()
    const logger = makeLogger()
    const delivered: DecodedFrame[] = []

    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
      source,
      opts: { fps: 5, format: 'gray' },
      onDecodedFrame: (frame) => {
        delivered.push(frame)
      },
    })

    await flush()
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 4, height: 4, format: 'gray' })
    await flush()
    const toBufferReq = fake.sent.find((m) => m.kind === 'toBuffer')
    if (!toBufferReq || toBufferReq.kind !== 'toBuffer')
      throw new Error('expected toBuffer request')
    expect(toBufferReq.opts?.format).toBe('gray')

    fake.emit({ kind: 'buffer', frameId: 1, bytes: new Uint8Array([7]) })
    await flush()
    expect(delivered[0]?.format).toBe('gray')

    stop()
  })

  it('skips pixel materialization when the upstream admission hook rejects a frame', async () => {
    const fake = createFakeChild()
    const onDecodedFrame = vi.fn()
    const shouldMaterializeFrame = vi.fn().mockReturnValue(false)

    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 10, format: 'rgb' },
      shouldMaterializeFrame,
      onDecodedFrame,
    })

    await flush()
    fake.emit({ kind: 'frame', frameId: 7, timestamp: 1, width: 3840, height: 2160, format: 'rgb' })
    await flush()

    expect(shouldMaterializeFrame).toHaveBeenCalledOnce()
    expect(fake.sent.some((m) => m.kind === 'toBuffer')).toBe(false)
    expect(onDecodedFrame).not.toHaveBeenCalled()

    stop()
    fake.emit({ kind: 'ended' })
    await flush()
  })
})

describe("'immediate' teardown kills NOW, even with a pull pending (D666)", () => {
  it('SIGKILLs and sends stop in the same turn — never behind the generator', async () => {
    const fake = createFakeChild()
    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 10, format: 'rgb' },
      onDecodedFrame: () => undefined,
    })
    // The worker is forked and asked for a frame it never sends: the
    // generator is parked in `await session.pullNext()`, not at a `yield`.
    await flush()
    expect(fake.sent.some((m) => m.kind === 'pull')).toBe(true)
    expect(fake.kill).not.toHaveBeenCalled()

    // Shutdown. The runner calls `process.exit(0)` right after this returns,
    // so a kill queued behind `iterator.return()` is a kill that never lands:
    // on the Mac agent that orphaned every decode worker.
    stop('immediate')
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(true)

    // The generator's own `finally` later finds the session stopped: one kill.
    fake.emit({ kind: 'ended' })
    await flush()
    expect(fake.kill).toHaveBeenCalledTimes(1)
  })
})

describe('the kill bookkeeping around shutdown (D666 review)', () => {
  it('a SIGKILL that threw is tried again by the next escalation (L1)', async () => {
    const fake = createFakeChild()
    fake.kill.mockImplementationOnce(() => {
      throw new Error('EPERM')
    })
    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 10, format: 'rgb' },
      onDecodedFrame: () => undefined,
    })
    await flush()
    stop('immediate')
    // The generator's own `finally` escalates again once the pull settles.
    fake.emit({ kind: 'ended' })
    await flush()
    expect(fake.kill.mock.calls).toEqual([['SIGKILL'], ['SIGKILL']])
  })

  it('a worker the runner killed at shutdown is not warned about as an unexpected death (L2)', async () => {
    const fake = createFakeChild()
    const exitHandlers: Array<(info: unknown) => void> = []
    const child: ForkedChildLike = {
      ...fake.child,
      on: (ev, cb) => {
        if (ev === 'exit') exitHandlers.push(cb)
        else fake.child.on(ev, cb)
      },
    }
    const logger = makeLogger()
    startSessionDecodePump({
      fork: () => child,
      lease: testLease,
      hwaccel: () => null,
      logger,
      source,
      opts: { fps: 10, format: 'rgb' },
      onDecodedFrame: () => undefined,
    })
    await flush()
    // An occupancy burst's session is never torn down: the registry's SIGKILL
    // is the only kill, and the exit says so.
    for (const handler of exitHandlers) {
      handler({ code: null, signal: 'SIGKILL', killedByRunner: true })
    }
    await flush()
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('exited unexpectedly'),
      expect.anything(),
    )
  })

  it('a worker that died on its own is still warned about', async () => {
    const fake = createFakeChild()
    const exitHandlers: Array<(info: unknown) => void> = []
    const child: ForkedChildLike = {
      ...fake.child,
      on: (ev, cb) => {
        if (ev === 'exit') exitHandlers.push(cb)
        else fake.child.on(ev, cb)
      },
    }
    const logger = makeLogger()
    startSessionDecodePump({
      fork: () => child,
      lease: testLease,
      hwaccel: () => null,
      logger,
      source,
      opts: { fps: 10, format: 'rgb' },
      onDecodedFrame: () => undefined,
    })
    await flush()
    for (const handler of exitHandlers) handler({ code: null, signal: 'SIGKILL' })
    await flush()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('exited unexpectedly'),
      expect.objectContaining({ tags: { deviceId: 42 } }),
    )
  })
})
