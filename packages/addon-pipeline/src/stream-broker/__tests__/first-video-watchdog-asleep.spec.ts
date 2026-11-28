/**
 * A CAMERA KNOWN TO BE ASLEEP IS WAITED FOR, NOT RECONNECTED IN A LOOP.
 *
 * 3629, 2026-11-20: the provider committed `battery sleep state {sleeping:true}`
 * and closed its streams, and the first-video watchdog still fired at +13 s and
 * +22 s ("no video RTP after source connect — forcing reconnect"), a third dial
 * at +35 s; the camera woke on its own at +33 s. A committed sleep is a reason
 * the watchdog must hold off; the wake is the reconnect.
 */
import * as net from 'node:net'
import type { IScopedLogger, StreamSource } from '@dominevo/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker.js'

function createMockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

const SDP = ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000'].join('\r\n')

function source(port: number): StreamSource {
  return {
    type: 'rfc4571',
    url: `tcp://127.0.0.1:${port}`,
    videoCodec: 'h264',
    metadata: { sdp: SDP },
  }
}

/** Let real socket I/O run while the timers are faked. */
async function ioTurns(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r))
}

const FORCING = 'first-video watchdog: no video RTP after source connect — forcing reconnect'
const WAITING =
  'first-video watchdog: camera is asleep — waiting for the wake instead of reconnecting'

describe('first-video watchdog — a camera known to be asleep', () => {
  let server: net.Server
  let port = 0
  const sockets: net.Socket[] = []
  let broker: StreamBroker
  let logger: IScopedLogger

  beforeEach(async () => {
    server = net.createServer((sock) => {
      sockets.push(sock)
      sock.on('data', () => {})
      sock.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    logger = createMockLogger()
    broker = new StreamBroker('3629/native:main', logger)
    broker.onEncodedData(() => {})
    broker.setSourceProvider(() => source(port))
    await broker.start(source(port))
    await ioTurns()
  })

  afterEach(async () => {
    await broker.stop()
    for (const s of sockets) s.destroy()
    sockets.length = 0
    vi.useRealTimers()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('does not force reconnects, logs the wait ONCE, and reconnects once on the wake', async () => {
    expect(broker.getFirstVideoWatchdogStatus().armed).toBe(true)
    broker.setDeviceAsleep(true)

    await vi.advanceTimersByTimeAsync(8_500)
    await vi.advanceTimersByTimeAsync(20_000)

    expect(logger.warn).not.toHaveBeenCalledWith(FORCING, expect.anything())
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('activity watchdog'),
      expect.anything(),
    )
    const waits = vi
      .mocked(logger.info)
      .mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('camera is asleep'))
    expect(waits).toHaveLength(1)
    expect(waits[0]?.[1]).toMatchObject({ tags: { deviceId: 3629 } })

    broker.setDeviceAsleep(false)
    const forced = vi.mocked(logger.warn).mock.calls.filter(([msg]) => msg === FORCING)
    expect(forced).toHaveLength(1)
  })

  it('a wake that never arrives is waited for only up to the bound, then reconnected once', async () => {
    broker.setDeviceAsleep(true)
    await vi.advanceTimersByTimeAsync(8_500)
    expect(logger.warn).not.toHaveBeenCalledWith(FORCING, expect.anything())
    await vi.advanceTimersByTimeAsync(46_000)
    expect(logger.warn).toHaveBeenCalledWith(
      'watchdog: no wake within the bound — reconnecting anyway',
      expect.objectContaining({ tags: { deviceId: 3629 } }),
    )
    const forced = vi.mocked(logger.warn).mock.calls.filter(([msg]) => msg === FORCING)
    expect(forced.length).toBeGreaterThanOrEqual(1)
  })

  it('an UNKNOWN sleep state keeps the current behaviour: the watchdog forces the reconnect', async () => {
    await vi.advanceTimersByTimeAsync(8_500)
    expect(logger.warn).toHaveBeenCalledWith(FORCING, expect.anything())
    expect(logger.info).not.toHaveBeenCalledWith(WAITING, expect.anything())
  })
})
