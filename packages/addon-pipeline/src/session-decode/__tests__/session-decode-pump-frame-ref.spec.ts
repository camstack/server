import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { startSessionDecodePump } from '../session-decode-pump.js'
import { LocalFrameRegistry } from '../local-frame-registry.js'
import type { ForkedChildLike } from '../session-decode-coordinator.js'
import type { WorkerReply, WorkerRequest } from '../worker-protocol.js'
import { testLease } from './test-lease-knobs.js'

function fakeChild(): {
  child: ForkedChildLike
  sent: WorkerRequest[]
  emit(reply: WorkerReply): void
} {
  const sent: WorkerRequest[] = []
  const handlers: Array<(message: unknown) => void> = []
  return {
    child: {
      send: (message) => sent.push(message),
      on: (event, handler) => {
        if (event === 'message') handlers.push(handler)
      },
      kill: vi.fn(),
    },
    sent,
    emit: (reply) => handlers.forEach((handler) => handler(reply)),
  }
}

function logger(): IScopedLogger {
  const value: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => value,
    withTags: () => value,
  }
  return value
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('session decode pump local frame refs', () => {
  it('copies the pixels inline while the frame is still reserved when the runner is backed up', async () => {
    // A lazy ref is a promise the worker keeps for `holdFrames` (8) frames.
    // Under backpressure — a cold engine loading its models, a full queue —
    // the executor read its pixels ~11 s later, the hold had rolled over,
    // and the worker answered "unknown or stale frameId" ~26 times an hour.
    // The shm passthrough already falls back to inline copies under the same
    // condition; the ref transport now asks the same question per frame.
    const fake = fakeChild()
    const registry = new LocalFrameRegistry({
      registryId: 'pump-test',
      maxFrames: 2,
      maxBytes: 1_000_000,
    })
    const onFrameRef = vi.fn()
    const onDecodedFrame = vi.fn()
    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: logger(),
      source: { restreamUrl: 'rtsp://test', deviceId: 1, codec: 'h264' },
      opts: { format: 'rgb' },
      shouldMaterializeFrame: () => true,
      frameRegistry: registry,
      inlineWhen: () => true,
      inlineViewSpec: { content: { width: 640, height: 640 }, fit: 'contain', format: 'rgb' },
      onFrameRef,
      onDecodedFrame,
    })

    await flush()
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 1920, height: 1080, format: 'rgb' })
    await flush()

    // Pixels asked for NOW — not registered as a ref for later.
    expect(fake.sent.some((message) => message.kind === 'toBuffer')).toBe(true)
    expect(registry.size).toBe(0)
    expect(onFrameRef).not.toHaveBeenCalled()

    stop()
    fake.emit({ kind: 'ended' })
  })

  it('does not register, retain, or materialize a frame rejected by admission', async () => {
    const fake = fakeChild()
    const registry = new LocalFrameRegistry({
      registryId: 'pump-test',
      maxFrames: 2,
      maxBytes: 1_000_000,
    })
    const onFrameRef = vi.fn()
    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: logger(),
      source: { restreamUrl: 'rtsp://test', deviceId: 1, codec: 'h264' },
      opts: { format: 'rgb' },
      shouldMaterializeFrame: () => false,
      frameRegistry: registry,
      onFrameRef,
      onDecodedFrame: vi.fn(),
    })

    await flush()
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 1920, height: 1080, format: 'rgb' })
    await flush()

    expect(registry.size).toBe(0)
    expect(fake.sent.some((message) => message.kind === 'toBuffer')).toBe(false)
    expect(fake.sent.some((message) => message.kind === 'releaseNativeLease')).toBe(false)
    expect(onFrameRef).not.toHaveBeenCalled()

    stop()
    fake.emit({ kind: 'ended' })
    await flush()
  })

  it('registers a co-located frameRef without eager pixels and preserves native controls', async () => {
    const fake = fakeChild()
    const registry = new LocalFrameRegistry({
      registryId: 'pump-test',
      maxFrames: 2,
      maxBytes: 100_000_000,
    })
    const onFrameRef = vi.fn((_frame, native) => {
      native?.markInferred()
      native?.cutTiles([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }])
      return true
    })
    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: logger(),
      source: { restreamUrl: 'rtsp://test', deviceId: 1, codec: 'h264' },
      opts: { format: 'rgb' },
      shouldMaterializeFrame: () => true,
      frameRegistry: registry,
      onFrameRef,
      onDecodedFrame: vi.fn(),
    })

    await flush()
    fake.emit({
      kind: 'frame',
      frameId: 2,
      timestamp: 22,
      width: 1920,
      height: 1080,
      format: 'rgb',
    })
    await flush()

    expect(fake.sent.some((message) => message.kind === 'toBuffer')).toBe(false)
    expect(onFrameRef).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ byteLength: 0 }),
        width: 1920,
        height: 1080,
        frameRef: expect.objectContaining({ registryId: 'pump-test' }),
      }),
      expect.any(Function),
    )
    expect(fake.sent.some((message) => message.kind === 'markInferred')).toBe(true)
    expect(fake.sent.some((message) => message.kind === 'cutTiles')).toBe(true)

    stop()
    fake.emit({ kind: 'ended' })
    await flush()
  })
})
