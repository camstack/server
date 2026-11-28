/**
 * A BATTERY CAMERA IS NEVER DIALLED IN A LOOP.
 *
 * Device 640 (Argus 3E), 2026-11-19..21: a camera that was asleep (then dead)
 * was logged in to ~60 times an hour — 1 439 times on 11-19 — because the
 * broker, holding a consumer, re-entered the lazy-materialize branch on the
 * exponential backoff capped at 30 s (`MAX_RECONNECT_DELAY_MS`) for ever, and
 * every pass asks the publisher to materialize the socket, which logs in. The
 * first-video watchdog added 182 kills in a day, each reconnecting at the
 * floor delay with a fresh publisher request.
 *
 * The rules pinned here (battery cameras only — a wired camera is unchanged):
 *  - a materialize that does not land inside its deadline is GIVEN UP, once,
 *    and not repeated on a timer;
 *  - a run of watchdog kills with no video in between is bounded and then given
 *    up too, instead of reconnecting at the floor delay for ever;
 *  - the next awake transition (or a fresh demand edge) is what tries again.
 */
import * as net from 'node:net'
import { Socket } from 'node:net'
import type { IScopedLogger, StreamSource } from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker.js'
import { RtspSession } from '../rtsp/rtsp-session.js'

const HOUR = 3_600_000
const SDP = ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000'].join('\r\n')

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

const lazySource = (): StreamSource => ({
  type: 'rfc4571',
  url: 'lazy:rfc4571:native%3Amain',
  videoCodec: 'h264',
  metadata: { sdp: SDP },
})

const realSource = (port: number): StreamSource => ({
  type: 'rfc4571',
  url: `tcp://127.0.0.1:${port}`,
  videoCodec: 'h264',
  metadata: { sdp: SDP },
})

async function ioTurns(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r))
}

describe('battery camera: the lazy materialize is not retried for ever', () => {
  let broker: StreamBroker
  let logger: IScopedLogger
  let requests: number
  let unsubscribeFirst: () => void = () => {}

  const setup = async (battery: boolean): Promise<void> => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    logger = createMockLogger()
    requests = 0
    broker = new StreamBroker('640/native:main', logger)
    broker.setBatteryProbe(() => battery)
    // A consumer with live intent (a recording, a live view): the broker dials.
    unsubscribeFirst = broker.onEncodedData(() => {})
    broker.setSourceProvider(() => lazySource())
    broker.setRequestSourceRefresh(() => {
      requests++
    })
    await broker.start(lazySource())
  }

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('stops asking the publisher once the materialize deadline passed, over a whole hour', async () => {
    await setup(true)
    await vi.advanceTimersByTimeAsync(HOUR)
    // One episode: flat 1 s polls inside the 20 s deadline, then silence.
    expect(requests).toBeLessThanOrEqual(25)
    const gaveUp = vi
      .mocked(logger.info)
      .mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('gave up'))
    // Said ONCE per transition, with the device tag (D391).
    expect(gaveUp).toHaveLength(1)
    expect(gaveUp[0]?.[1]).toMatchObject({ tags: { deviceId: 640 } })
  })

  it('tries again on the awake transition — one more episode, not a loop', async () => {
    await setup(true)
    broker.setDeviceAsleep(true)
    await vi.advanceTimersByTimeAsync(HOUR / 2)
    const afterFirst = requests
    expect(afterFirst).toBeLessThanOrEqual(25)

    broker.setDeviceAsleep(false)
    await vi.advanceTimersByTimeAsync(HOUR / 2)
    expect(requests).toBeGreaterThan(afterFirst)
    expect(requests).toBeLessThanOrEqual(2 * 25)
  })

  // THE EDGES that end a give-up. The give-up leaves the same demand state as
  // `suspend()`, and a NEW live consumer (never a sentry) is what dials again.
  it('(a) the last consumer leaves, a new one attaches: exactly one bounded episode', async () => {
    await setup(true)
    await vi.advanceTimersByTimeAsync(60_000)
    const gaveUpAt = requests
    unsubscribeFirst()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requests).toBe(gaveUpAt)

    broker.onEncodedData(() => {})
    await vi.advanceTimersByTimeAsync(HOUR / 2)
    expect(requests).toBeGreaterThan(gaveUpAt)
    expect(requests - gaveUpAt).toBeLessThanOrEqual(25)
  })

  it('(b) a recorder stays attached, then a live viewer attaches: one bounded episode', async () => {
    await setup(true)
    await vi.advanceTimersByTimeAsync(60_000)
    const gaveUpAt = requests
    // Churn that adds no live consumer is not an edge.
    await vi.advanceTimersByTimeAsync(HOUR / 4)
    expect(requests).toBe(gaveUpAt)

    broker.onEncodedData(() => {})
    await vi.advanceTimersByTimeAsync(HOUR / 2)
    expect(requests).toBeGreaterThan(gaveUpAt)
    expect(requests - gaveUpAt).toBeLessThanOrEqual(25)
  })

  it('(c) a sentry session attaching after the give-up does not dial', async () => {
    await setup(true)
    await vi.advanceTimersByTimeAsync(60_000)
    const gaveUpAt = requests
    broker.getRtspRestreamer().addSession(
      new RtspSession(new Socket(), '', undefined, true, {
        intent: 'sentry',
        preRollRequestMs: 0,
      }),
    )
    await vi.advanceTimersByTimeAsync(HOUR / 2)
    expect(requests).toBe(gaveUpAt)
  })

  it('a re-publish of a REAL source revives a given-up broker; the sentinel going back does not', async () => {
    let published: StreamSource = lazySource()
    await setup(true)
    broker.setSourceProvider(() => published)
    await vi.advanceTimersByTimeAsync(60_000)
    const gaveUpAt = requests

    broker.kickReconnect()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(requests).toBe(gaveUpAt)

    published = { ...realSource(1), url: 'tcp://127.0.0.1:1' }
    broker.kickReconnect()
    await vi.advanceTimersByTimeAsync(1_000)
    const resumed = vi
      .mocked(logger.info)
      .mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('is back'))
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.[1]).toMatchObject({
      tags: { deviceId: 640 },
      meta: { trigger: 'republish' },
    })
  })

  it('leaves a wired camera exactly as it was: it keeps retrying on the backoff', async () => {
    await setup(false)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(requests).toBeGreaterThan(60)
  })
})

describe('a camera known to be ASLEEP is not polled at 1 s while its source is built', () => {
  let broker: StreamBroker
  let logger: IScopedLogger
  let requests: number

  const setup = async (): Promise<void> => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    logger = createMockLogger()
    requests = 0
    broker = new StreamBroker('5487/native:main', logger)
    // The probe does not say battery: the committed sleep state alone is enough.
    broker.setBatteryProbe(() => false)
    broker.setDeviceAsleep(true)
    broker.onEncodedData(() => {})
    broker.setSourceProvider(() => lazySource())
    broker.setRequestSourceRefresh(() => {
      requests++
    })
    await broker.start(lazySource())
  }

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('asks the publisher once, says it stopped once, and stays quiet', async () => {
    await setup()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(requests).toBeLessThanOrEqual(2)
    const gaveUp = vi
      .mocked(logger.info)
      .mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('gave up'))
    expect(gaveUp).toHaveLength(1)
    expect(gaveUp[0]?.[1]).toMatchObject({ tags: { deviceId: 5487 } })
  })

  it('a live viewer attaching afterwards still triggers an immediate attempt', async () => {
    await setup()
    await vi.advanceTimersByTimeAsync(60_000)
    const before = requests
    broker.onEncodedData(() => {})
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toBeGreaterThan(before)
  })
})

describe('battery camera: the watchdog does not redial at the floor delay for ever', () => {
  let server: net.Server
  let port = 0
  let connections = 0
  const sockets: net.Socket[] = []
  let broker: StreamBroker
  let logger: IScopedLogger
  let requests: number

  const setup = async (battery: boolean): Promise<void> => {
    server = net.createServer((sock) => {
      connections++
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
    requests = 0
    connections = 0
    broker = new StreamBroker('640/native:main', logger)
    broker.setBatteryProbe(() => battery)
    broker.onEncodedData(() => {})
    broker.setSourceProvider(() => realSource(port))
    broker.setRequestSourceRefresh(() => {
      requests++
    })
    await broker.start(realSource(port))
    await ioTurns()
  }

  afterEach(async () => {
    await broker.stop()
    for (const s of sockets) s.destroy()
    sockets.length = 0
    vi.useRealTimers()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const advance = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000)
      await ioTurns(2)
    }
  }

  it('gives up after a bounded run of kills with no video, unknown sleep state included', async () => {
    await setup(true)
    await advance(HOUR / 4)
    // Unbounded, this is ~one dial per 8-10 s: hundreds in 15 minutes.
    expect(connections).toBeLessThanOrEqual(8)
    expect(requests).toBeLessThanOrEqual(8)
    const gaveUp = vi
      .mocked(logger.info)
      .mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('gave up'))
    expect(gaveUp).toHaveLength(1)
    expect(gaveUp[0]?.[1]).toMatchObject({ tags: { deviceId: 640 } })

    // The next awake transition is what tries again: dials resume.
    const before = connections
    broker.setDeviceAsleep(true)
    broker.setDeviceAsleep(false)
    await advance(30_000)
    expect(connections).toBeGreaterThan(before)
  })

  it('a wired camera keeps its immediate reconnect', async () => {
    await setup(false)
    await advance(HOUR / 4)
    expect(connections).toBeGreaterThan(30)
  })
})
