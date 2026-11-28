import type { IScopedLogger } from '@dominevo/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionDecodeCoordinator,
  type ForkedChildLike,
} from '../session-decode-coordinator.js'
import type { NativeCropAttempt, VideoFrame, VideoFrameSource } from '../video-frame-generator.js'
import type { WorkerReply, WorkerRequest } from '../worker-protocol.js'
import { testLease } from './test-lease-knobs.js'

function createFakeChild(): {
  child: ForkedChildLike
  sent: WorkerRequest[]
  emit: (reply: WorkerReply) => void
  emitExit: () => void
} {
  const sent: WorkerRequest[] = []
  const messageHandlers: Array<(m: unknown) => void> = []
  const exitHandlers: Array<() => void> = []
  const child: ForkedChildLike = {
    send: (msg: WorkerRequest) => sent.push(msg),
    on: (ev: 'message' | 'exit', cb: ((m: unknown) => void) | (() => void)) => {
      if (ev === 'message') messageHandlers.push(cb as (m: unknown) => void)
      else exitHandlers.push(cb as () => void)
    },
    kill: vi.fn(),
  }
  return {
    child,
    sent,
    emit: (reply) => messageHandlers.forEach((h) => h(reply)),
    emitExit: () => exitHandlers.forEach((h) => h()),
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

const source: VideoFrameSource = { restreamUrl: 'rtsp://cam/1', deviceId: 1, codec: 'h264' }

/** Drive the generator until it yields the first VideoFrame (frameId=7). */
async function firstFrame(
  fake: ReturnType<typeof createFakeChild>,
  logger: IScopedLogger,
): Promise<{ frame: VideoFrame; iterator: AsyncGenerator<VideoFrame, void> }> {
  const coordinator = createSessionDecodeCoordinator({
    fork: () => fake.child,
    lease: testLease,
    hwaccel: () => null,
    logger,
  })
  const iterator = coordinator.generateVideoFrames(source, { fps: 10, format: 'rgb' })
  const next = iterator.next()
  fake.emit({ kind: 'frame', frameId: 7, timestamp: 1, width: 3840, height: 2160, format: 'rgb' })
  const res = await next
  if (res.done) throw new Error('expected a frame')
  return { frame: res.value, iterator }
}

describe('coordinator native crop (via FrameImage.nativeCrop)', () => {
  let fake: ReturnType<typeof createFakeChild>
  let logger: IScopedLogger

  beforeEach(() => {
    fake = createFakeChild()
    logger = makeLogger()
  })

  it('resolves a nativeCropResult with its bytes + dims (HIT)', async () => {
    const { frame } = await firstFrame(fake, logger)
    expect(frame.image.nativeCrop).toBeDefined()
    const p = frame.image.nativeCrop!({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 })
    // The worker got a nativeCrop request correlated by requestId, for frameId 7.
    const req = fake.sent.find((m) => m.kind === 'nativeCrop')
    expect(req).toMatchObject({ kind: 'nativeCrop', frameId: 7 })
    const requestId = req && req.kind === 'nativeCrop' ? req.requestId : -1
    fake.emit({
      kind: 'nativeCropResult',
      requestId,
      bytes: new Uint8Array([9, 8, 7]),
      width: 100,
      height: 120,
    })
    const result = await p
    expect(result).toEqual({
      kind: 'crop',
      crop: { bytes: new Uint8Array([9, 8, 7]), width: 100, height: 120 },
    })
  })

  it('releaseNativeLease sends a releaseNativeLease request for this frameId (fire-and-forget)', async () => {
    const { frame } = await firstFrame(fake, logger)
    expect(frame.image.releaseNativeLease).toBeDefined()
    frame.image.releaseNativeLease!()
    const req = fake.sent.find((m) => m.kind === 'releaseNativeLease')
    expect(req).toMatchObject({ kind: 'releaseNativeLease', frameId: 7 })
  })

  it('resolves a typed MISS on a nativeCropMiss (frame aged out → caller falls back)', async () => {
    const { frame } = await firstFrame(fake, logger)
    const p = frame.image.nativeCrop!({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 })
    const req = fake.sent.find((m) => m.kind === 'nativeCrop')
    const requestId = req && req.kind === 'nativeCrop' ? req.requestId : -1
    fake.emit({ kind: 'nativeCropMiss', requestId })
    expect(await p).toMatchObject({ kind: 'miss' })
  })

  it('still works after the frame is closed (native crops outlive the toBuffer lifetime)', async () => {
    const { frame } = await firstFrame(fake, logger)
    frame.image.close()
    const p = frame.image.nativeCrop!({ x: 0, y: 0, w: 0.5, h: 0.5 })
    const req = fake.sent.find((m) => m.kind === 'nativeCrop')
    const requestId = req && req.kind === 'nativeCrop' ? req.requestId : -1
    fake.emit({
      kind: 'nativeCropResult',
      requestId,
      bytes: new Uint8Array([1]),
      width: 2,
      height: 2,
    })
    expect(await p).toMatchObject({ kind: 'crop' })
  })

  it('resolves a typed MISS (never rejects) if the worker exits before replying', async () => {
    const { frame } = await firstFrame(fake, logger)
    const p = frame.image.nativeCrop!({ x: 0, y: 0, w: 0.5, h: 0.5 })
    fake.emitExit()
    expect(await p).toMatchObject({ kind: 'miss' })
  })

  describe('lease facts on a miss (which of the three causes lost the frame)', () => {
    async function missFor(frame: VideoFrame, reply: 'miss' | 'exit'): Promise<NativeCropAttempt> {
      const p = frame.image.nativeCrop!({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 })
      const req = fake.sent.find((m) => m.kind === 'nativeCrop')
      const requestId = req && req.kind === 'nativeCrop' ? req.requestId : -1
      if (reply === 'exit') fake.emitExit()
      else fake.emit({ kind: 'nativeCropMiss', requestId })
      return p
    }

    it('a fresh frame on a live worker is inside the hold', async () => {
      const { frame } = await firstFrame(fake, logger)
      const miss = await missFor(frame, 'miss')
      expect(miss).toMatchObject({
        kind: 'miss',
        lease: {
          workerState: 'live',
          framesSinceFrame: 0,
          holdFrames: 8,
          outsideHold: false,
          openImages: 1,
        },
      })
    })

    it('a frame older than the 8 newest delivered is outside the hold', async () => {
      const { frame, iterator } = await firstFrame(fake, logger)
      for (let i = 0; i < 8; i++) {
        const next = iterator.next()
        fake.emit({
          kind: 'frame',
          frameId: 100 + i,
          timestamp: 2 + i,
          width: 3840,
          height: 2160,
          format: 'rgb',
        })
        await next
      }
      const miss = await missFor(frame, 'miss')
      expect(miss).toMatchObject({
        lease: { framesSinceFrame: 8, holdFrames: 8, outsideHold: true, workerState: 'live' },
      })
    })

    it('a worker that died is reported exited, with the session id that took the lease', async () => {
      const { frame } = await firstFrame(fake, logger)
      const miss = await missFor(frame, 'exit')
      expect(miss).toMatchObject({ lease: { workerState: 'exited' } })
      if (miss.kind !== 'miss' || miss.lease === undefined) throw new Error('no lease facts')
      expect(Number.isInteger(miss.lease.sessionId)).toBe(true)
    })
  })

  it('carries the worker reason back to the CALLER, not only to the debug log', async () => {
    const { frame } = await firstFrame(fake, logger)
    const p = frame.image.nativeCrop!({ x: 0.4, y: 0.4, w: 0.02, h: 0.05 })
    const req = fake.sent.find((m) => m.kind === 'nativeCrop')
    const requestId = req && req.kind === 'nativeCrop' ? req.requestId : -1
    fake.emit({ kind: 'nativeCropMiss', requestId, reason: 'crop failed — sws_scale -22' })
    expect(await p).toMatchObject({ kind: 'miss', workerReason: 'crop failed — sws_scale -22' })
    expect(logger.debug).toHaveBeenCalledWith(
      'session-decode: native crop miss',
      expect.objectContaining({ meta: { requestId, reason: 'crop failed — sws_scale -22' } }),
    )
  })

  it('routes a worker log reply onto the matching scoped-logger level', async () => {
    await firstFrame(fake, logger)
    fake.emit({ kind: 'log', level: 'warn', message: '[dev:1] native crop failed — boom' })
    expect(logger.warn).toHaveBeenCalledWith('[dev:1] native crop failed — boom')
    fake.emit({ kind: 'log', level: 'debug', message: '[dev:1] provenance' })
    expect(logger.debug).toHaveBeenCalledWith('[dev:1] provenance')
  })
})
