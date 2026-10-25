/**
 * The HOLD's lifetime, end to end: a delivered frame stays alive until ITS
 * `FrameResult` comes back, at which moment the runner takes the subject tiles
 * it wanted and the frame is freed.
 *
 * What is checked here is the seam nobody can see from either side alone: that
 * `cutTiles` names the frame the result belongs to, carries that frame's boxes,
 * and is sent even when there were none. The last one is the case that matters
 * most in aggregate — the majority of frames detect nothing, and it is their
 * prompt release that gives back the ~800 MB the old TTL lease pinned per busy
 * 4K worker.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  createSessionDecodeCoordinator,
  type ForkedChildLike,
} from '../session-decode-coordinator.js'
import type { VideoFrameSource } from '../video-frame-generator.js'
import { isWorkerRequest, type WorkerReply, type WorkerRequest } from '../worker-protocol.js'
import { testLease } from './test-lease-knobs.js'

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

function createFakeChild(): {
  child: ForkedChildLike
  sent: WorkerRequest[]
  emit: (reply: WorkerReply) => void
} {
  const sent: WorkerRequest[] = []
  const handlers: Array<(m: unknown) => void> = []
  const child: ForkedChildLike = {
    send: (msg) => sent.push(msg),
    on: (ev, cb) => {
      if (ev === 'message') handlers.push(cb)
    },
    kill: vi.fn(),
  }
  return { child, sent, emit: (reply) => handlers.forEach((h) => h(reply)) }
}

const source: VideoFrameSource = { restreamUrl: 'rtsp://cam/1', deviceId: 101, codec: 'h264' }

const BOX = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }

describe('worker protocol — cutTiles', () => {
  it('accepts a well-formed cut, with or without boxes', () => {
    expect(isWorkerRequest({ kind: 'cutTiles', frameId: 7, bboxes: [] })).toBe(true)
    expect(isWorkerRequest({ kind: 'cutTiles', frameId: 7, bboxes: [BOX] })).toBe(true)
  })

  it('rejects a malformed cut rather than letting junk geometry reach the worker', () => {
    expect(isWorkerRequest({ kind: 'cutTiles', frameId: 7 })).toBe(false)
    expect(isWorkerRequest({ kind: 'cutTiles', bboxes: [] })).toBe(false)
    expect(isWorkerRequest({ kind: 'cutTiles', frameId: 7, bboxes: [{ x: 1 }] })).toBe(false)
    expect(isWorkerRequest({ kind: 'cutTiles', frameId: 7, bboxes: 'all' })).toBe(false)
  })
})

describe('coordinator — the hold ends at the frame’s own result', () => {
  it('cuts tiles for THAT frame id, carrying that frame’s boxes', async () => {
    const fake = createFakeChild()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
    })
    const iterator = coordinator.generateVideoFrames(source, { format: 'rgb' })

    const first = iterator.next()
    fake.emit({ kind: 'frame', frameId: 41, timestamp: 1, width: 640, height: 360, format: 'rgb' })
    const res = await first
    if (res.done) throw new Error('expected a frame')

    // The result for frame 41 arrives (later, off the pull path).
    res.value.image.cutTiles?.([BOX])

    expect(fake.sent).toContainEqual({ kind: 'cutTiles', frameId: 41, bboxes: [BOX] })
    await iterator.return()
  })

  // A positional signal ("the last frame you gave me") desynchronises the first
  // time a pull resolves out of order, and the failure is silent: the tiles
  // would be cut from the wrong frame and nothing would say so.
  it('names the frame, so two frames in flight cannot be confused', async () => {
    const fake = createFakeChild()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
    })
    const iterator = coordinator.generateVideoFrames(source, { format: 'rgb' })

    const first = iterator.next()
    fake.emit({ kind: 'frame', frameId: 41, timestamp: 1, width: 640, height: 360, format: 'rgb' })
    const a = await first
    if (a.done) throw new Error('expected a frame')

    const second = iterator.next()
    fake.emit({ kind: 'frame', frameId: 42, timestamp: 2, width: 640, height: 360, format: 'rgb' })
    const b = await second
    if (b.done) throw new Error('expected a frame')

    // Results come back out of order — 42 first, then 41.
    b.value.image.cutTiles?.([])
    a.value.image.cutTiles?.([BOX])

    const cuts = fake.sent.filter((m) => m.kind === 'cutTiles')
    expect(cuts).toEqual([
      { kind: 'cutTiles', frameId: 42, bboxes: [] },
      { kind: 'cutTiles', frameId: 41, bboxes: [BOX] },
    ])
    await iterator.return()
  })

  it('an EMPTY cut is still sent — that is how a frame with no detections is freed', async () => {
    const fake = createFakeChild()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
    })
    const iterator = coordinator.generateVideoFrames(source, { format: 'rgb' })
    const first = iterator.next()
    fake.emit({ kind: 'frame', frameId: 9, timestamp: 1, width: 640, height: 360, format: 'rgb' })
    const res = await first
    if (res.done) throw new Error('expected a frame')

    res.value.image.cutTiles?.([])

    expect(fake.sent).toContainEqual({ kind: 'cutTiles', frameId: 9, bboxes: [] })
    await iterator.return()
  })

  it('sends nothing for a frame whose result never came back', async () => {
    const fake = createFakeChild()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
    })
    const iterator = coordinator.generateVideoFrames(source, { format: 'rgb' })
    const first = iterator.next()
    fake.emit({ kind: 'frame', frameId: 5, timestamp: 1, width: 640, height: 360, format: 'rgb' })
    await first
    // The runner never produced a result: the worker's hold bound is what
    // reclaims this one, and it is counted as `holdOverflow` there.
    expect(fake.sent.some((m) => m.kind === 'cutTiles')).toBe(false)
    await iterator.return()
  })
})
