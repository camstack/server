/**
 * The broker's way back from "no pinned ffmpeg" (D540): a refusal asks again,
 * once, under a bound; and a resolved path reaches the brokers that ALREADY
 * exist, because each one reads the manager's live config per dial.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { FfmpegReresolver, wireBrokerFfmpeg } from '../ffmpeg-reresolve.js'
import { StreamBroker } from '../stream-broker.js'
import { StreamBrokerManager } from '../stream-broker-manager.js'

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

describe('FfmpegReresolver', () => {
  it('single-flights: a burst of refusals starts ONE attempt', async () => {
    let calls = 0
    const r = new FfmpegReresolver({
      resolve: async () => {
        calls += 1
        return '/deps/ffmpeg'
      },
      apply: () => {},
      logger: makeLogger(),
    })
    expect(r.request('a')).toBe('started')
    expect(r.request('b')).toBe('in-flight')
    await r.settled()
    expect(calls).toBe(1)
  })

  it('is BOUNDED: a second attempt inside the window is refused, one after it runs', async () => {
    let now = 1_000
    let calls = 0
    const r = new FfmpegReresolver({
      resolve: async () => {
        calls += 1
        throw new Error('still down')
      },
      apply: () => {},
      logger: makeLogger(),
      now: () => now,
      minIntervalMs: 30_000,
    })
    r.request('first')
    await r.settled()
    now += 29_999
    expect(r.request('too soon')).toBe('too-soon')
    now += 1
    expect(r.request('after the bound')).toBe('started')
    await r.settled()
    expect(calls).toBe(2)
  })

  it('applies the path on success and logs a failure without throwing', async () => {
    const apply = vi.fn()
    const logger = makeLogger()
    let fail = true
    const r = new FfmpegReresolver({
      resolve: async () => {
        if (fail) throw new Error('download failed')
        return '/deps/ffmpeg-pinned'
      },
      apply,
      logger,
      minIntervalMs: 0,
    })
    r.request('boot miss')
    await r.settled()
    expect(apply).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('still unavailable'),
      expect.objectContaining({ meta: { error: 'download failed' } }),
    )
    fail = false
    r.request('next refusal')
    await r.settled()
    expect(apply).toHaveBeenCalledWith('/deps/ffmpeg-pinned')
  })
})

describe('wireBrokerFfmpeg — the addon wiring, end to end through a LIVE broker', () => {
  it('a boot-time miss, then a refused ingress, then a success: the live broker spawns the pinned path', async () => {
    const logger = makeLogger()
    const manager = new StreamBrokerManager(logger)
    // A broker that already exists when the binary arrives, bound the way
    // `ensureBroker` binds every broker.
    const broker = new StreamBroker('101/native:main', logger)
    manager.bindBrokerFfmpeg(broker)
    const demuxMirror: (string | null)[] = []
    let calls = 0
    const wiring = wireBrokerFfmpeg({
      host: manager,
      resolve: async () => {
        calls += 1
        if (calls === 1) throw new Error('download failed')
        return '/deps/ffmpeg-pinned'
      },
      hwAccel: () => 'copy',
      onBinaryPath: (binaryPath) => {
        demuxMirror.push(binaryPath)
      },
      logger,
      minIntervalMs: 0,
    })

    await wiring.load()
    expect(broker.getFfmpegBinaryPath()).toBeNull()

    // The broker's ffmpeg-parser ingress is refused — the real refusal branch
    // — and that refusal is what asks for the binary again.
    const startIngress = Reflect.get(broker, 'startFfmpegSourceReader')
    if (typeof startIngress !== 'function') throw new Error('startFfmpegSourceReader moved')
    startIngress.call(broker, {
      type: 'rtsp',
      url: 'rtsp://cam/main',
      ffmpegParser: { transport: 'tcp' },
    })
    await wiring.settled()

    expect(calls).toBe(2)
    expect(broker.getFfmpegBinaryPath()).toBe('/deps/ffmpeg-pinned')
    expect(demuxMirror).toEqual([null, '/deps/ffmpeg-pinned'])
    await broker.stop()
  })

  it('brokers created before AND after the resolution both read it — nothing is copied at creation', async () => {
    const logger = makeLogger()
    const manager = new StreamBrokerManager(logger)
    const wiring = wireBrokerFfmpeg({
      host: manager,
      resolve: async () => '/deps/ffmpeg-pinned',
      hwAccel: () => 'copy',
      logger,
    })
    const early = new StreamBroker('101/native:main', logger)
    manager.bindBrokerFfmpeg(early)
    await wiring.load()
    const late = new StreamBroker('616/native:main', logger)
    manager.bindBrokerFfmpeg(late)
    expect(early.getFfmpegBinaryPath()).toBe('/deps/ffmpeg-pinned')
    expect(late.getFfmpegBinaryPath()).toBe('/deps/ffmpeg-pinned')
  })
})
