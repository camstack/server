/**
 * `StreamProbeService` caches an ANSWER, never a failure: an empty probe (no
 * pinned binary, a refused dial, a timeout) cached for an hour turned one bad
 * moment into the camera's metadata for an hour.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { StreamProbeService } from './stream-probe.service'

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

describe('StreamProbeService — a failed probe is not cached', () => {
  it('asks again on the next probe after a failure', async () => {
    const logger = makeLogger()
    const resolveFfmpeg = vi.fn(async (): Promise<string> => {
      throw new Error('download failed')
    })
    const service = new StreamProbeService({ createLogger: () => logger }, resolveFfmpeg)
    expect(await service.probe('rtsp://cam/main')).toEqual({})
    expect(await service.probe('rtsp://cam/main')).toEqual({})
    // Twice: the first empty answer was not served from the cache.
    expect(resolveFfmpeg).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('no pinned ffmpeg'),
      expect.objectContaining({ meta: expect.objectContaining({ url: 'rtsp://cam/main' }) }),
    )
  })
})
