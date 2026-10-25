/**
 * The export dialog's still runs the node's PINNED ffmpeg (D540). It used to
 * default to `ffmpeg` on PATH ("the recorder's convention") and nobody passed a
 * path. Without the pinned build it answers no still — named per camera — and
 * spawns nothing.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { StillFrameService } from '../still-frame-service.js'

function makeLogger(error: IScopedLogger['error']): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const ROW = { path: 'x/low/seg.m4s', startMs: 0, durMs: 10_000, locationId: 'loc' }

/** A child that answers one JPEG and exits 0. */
function jpegChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() })
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from([0xff, 0xd8]))
    child.emit('close', 0)
  })
  // A structural ChildProcess: the service touches stdout, `on` and `kill`.
  return child as unknown as ChildProcess
}

describe('StillFrameService — the pinned ffmpeg (D540)', () => {
  it('REFUSES, per camera, and spawns nothing when the pinned build cannot be had', async () => {
    const error = vi.fn()
    const spawn = vi.fn(jpegChild)
    const service = new StillFrameService({
      lowSegmentsAt: () => [ROW],
      resolveAbsPath: () => '/rec/x/low/seg.m4s',
      logger: makeLogger(error),
      resolveFfmpeg: async () => {
        throw new Error('download failed')
      },
      spawn,
    })
    expect(await service.getStill(101, 5_000)).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('no pinned ffmpeg'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('spawns EXACTLY the pinned path it resolved', async () => {
    const spawn = vi.fn(jpegChild)
    const service = new StillFrameService({
      lowSegmentsAt: () => [ROW],
      resolveAbsPath: () => '/rec/x/low/seg.m4s',
      logger: makeLogger(vi.fn()),
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      spawn,
    })
    const still = await service.getStill(101, 5_000)
    expect(still?.jpeg.byteLength).toBe(2)
    expect(spawn.mock.calls.at(0)?.at(0)).toBe('/deps/ffmpeg-pinned')
  })
})
