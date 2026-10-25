/**
 * The `markInferred` round-trip: runner → coordinator → worker.
 *
 * Two things have to hold and neither is visible from either side alone:
 *
 * 1. The mark names the FRAME ID, not a position. A positional signal ("the
 *    last frame you gave me counted") desynchronises the first time a pull
 *    resolves out of the order the consumer assumed, and the failure would be
 *    silent — a dropped lease looks exactly like a lease that expired.
 * 2. The mark reaches the worker BEFORE the pull that supersedes that frame.
 *    Admission for frame N is decided inside the `pull` for frame N+1
 *    (`FrameSlot.reserveSlot`), so a mark sent after that pull arrives too late
 *    and the frame is already gone.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  createSessionDecodeCoordinator,
  type ForkedChildLike,
} from '../session-decode-coordinator.js'
import { isWorkerRequest, type WorkerReply, type WorkerRequest } from '../worker-protocol.js'
import type { VideoFrameSource } from '../video-frame-generator.js'
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

describe('worker protocol — markInferred', () => {
  it('accepts a well-formed mark and rejects one without a numeric frameId', () => {
    expect(isWorkerRequest({ kind: 'markInferred', frameId: 12 })).toBe(true)
    expect(isWorkerRequest({ kind: 'markInferred' })).toBe(false)
    expect(isWorkerRequest({ kind: 'markInferred', frameId: 'x' })).toBe(false)
  })
})

describe('coordinator — FrameImage.markInferred', () => {
  it('sends the mark for THAT frame id, before the pull that supersedes it', async () => {
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

    res.value.image.markInferred?.()

    // Ask for the next frame — this is the pull whose `reserveSlot` decides
    // frame 41's admission.
    const second = iterator.next()
    fake.emit({ kind: 'frame', frameId: 42, timestamp: 2, width: 640, height: 360, format: 'rgb' })
    await second

    const kinds = fake.sent.map((m) => m.kind)
    const markIdx = kinds.indexOf('markInferred')
    expect(markIdx).toBeGreaterThanOrEqual(0)
    const mark = fake.sent[markIdx]
    expect(mark).toEqual({ kind: 'markInferred', frameId: 41 })
    // The mark must precede the SECOND pull (the first pull is index 1, after `start`).
    const pullIdxs = kinds.flatMap((k, i) => (k === 'pull' ? [i] : []))
    expect(pullIdxs.length).toBeGreaterThanOrEqual(2)
    expect(markIdx).toBeLessThan(pullIdxs[1]!)

    await iterator.return()
  })

  it('does not mark a frame the consumer never marked', async () => {
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
    await first
    expect(fake.sent.some((m) => m.kind === 'markInferred')).toBe(false)
    await iterator.return()
  })
})
