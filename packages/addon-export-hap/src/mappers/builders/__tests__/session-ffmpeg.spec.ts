/**
 * A HomeKit live session runs the node's PINNED ffmpeg (D540). It spawned a
 * bare `'ffmpeg'` by design before — the host's binary. Without the pinned
 * build the start REFUSES, named per camera, before any broker round trip.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { requireSessionFfmpeg } from '../camera-streams.js'

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

describe('requireSessionFfmpeg', () => {
  it('answers the pinned path it resolved', async () => {
    const path = await requireSessionFfmpeg({
      resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
      log: makeLogger(vi.fn()),
      sessionId: 's-1',
      deviceId: 101,
    })
    expect(path).toBe('/deps/ffmpeg-pinned')
  })

  it('REFUSES with an ERROR carrying the camera, and never names PATH', async () => {
    const error = vi.fn()
    await expect(
      requireSessionFfmpeg({
        resolveFfmpeg: async () => {
          throw new Error('download failed')
        },
        log: makeLogger(error),
        sessionId: 's-2',
        deviceId: 101,
      }),
    ).rejects.toThrow('export-hap: no pinned ffmpeg for device 101')
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('no pinned ffmpeg'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })
})
