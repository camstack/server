import { EventEmitter } from 'node:events'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  type FeedLoss,
  type RobotFrameFeed,
  startRfc4571Server,
} from '../devices/dreame-rfc4571-server.js'

/**
 * The server around a FAKE feed and the REAL nodelink muxer: start the feed,
 * wait for the first keyframe, build an SDP with the parameter sets, frame
 * every later access unit as RTP for a TCP client, and call
 * `onConsumerDisconnect` once the last client has left.
 */
class FakeFeed extends EventEmitter implements RobotFrameFeed {
  started = 0
  stopped = 0
  async start(): Promise<void> {
    this.started += 1
  }
  async stop(): Promise<void> {
    this.stopped += 1
  }
}

const START = Buffer.from([0, 0, 0, 1])
// A minimal SPS (nal 7, profile 66 / level 30) and PPS (nal 8), then an IDR (nal 5).
const SPS = Buffer.from([0x67, 0x42, 0x00, 0x1e, 0xab, 0x40, 0x50, 0x1e, 0xc8])
const PPS = Buffer.from([0x68, 0xce, 0x38, 0x80])
const IDR = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x11, 0x22, 0x33])
const keyframe = Buffer.concat([START, SPS, START, PPS, START, IDR])
const pframe = Buffer.concat([START, Buffer.from([0x41, 0x9a, 0x01, 0x02, 0x03])])

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
}

function silentLogger() {
  // The scoped logger surface the server uses; nothing else is called.
  return noopLogger as unknown as Parameters<typeof startRfc4571Server>[0]['logger']
}

interface Recorded {
  readonly level: string
  readonly message: string
  readonly meta: Record<string, unknown> | undefined
}

/** A logger that keeps what it was told, so a silent branch is a failing test. */
function recordingLogger(into: Recorded[]) {
  const push =
    (level: string) =>
    (message: string, arg?: { meta?: Record<string, unknown> }): undefined => {
      into.push({ level, message, meta: arg?.meta })
      return undefined
    }
  const rec = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => rec,
  }
  return rec as unknown as Parameters<typeof startRfc4571Server>[0]['logger']
}

/** A 7-byte AAC-LC ADTS header: 44100 Hz, 2 channels (verified against the
 *  real `parseAdtsHeader`). */
const ADTS = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0xff, 0xfc])

describe('startRfc4571Server', () => {
  it('starts the feed, builds an SDP from the first keyframe and serves RTP to a TCP client', async () => {
    const feed = new FakeFeed()
    let disconnected = 0
    const starting = startRfc4571Server({
      stream: feed,
      logger: silentLogger(),
      bindHost: '127.0.0.1',
      audioGraceMs: 10,
      idleGraceMs: 30,
      onConsumerDisconnect: () => {
        disconnected += 1
      },
      onFeedLost: () => undefined,
    })
    // The keyframe arrives after start(); a little later than the listener wiring.
    setTimeout(
      () => feed.emit('videoAccessUnit', { data: keyframe, isKeyframe: true, microseconds: 0 }),
      5,
    )
    const rfc = await starting
    expect(feed.started).toBe(1)
    expect(rfc.host).toBe('127.0.0.1')
    expect(rfc.port).toBeGreaterThan(0)
    expect(rfc.sdp).toContain('m=video')
    expect(rfc.sdp).toContain('sprop-parameter-sets')
    expect(rfc.audio).toBeNull()

    const received: Buffer[] = []
    const client = net.connect(rfc.port, '127.0.0.1')
    await new Promise<void>((resolve) => client.once('connect', resolve))
    client.on('data', (b) => received.push(b))
    await new Promise((r) => setTimeout(r, 20))
    feed.emit('videoAccessUnit', { data: keyframe, isKeyframe: true, microseconds: 40_000 })
    feed.emit('videoAccessUnit', { data: pframe, isKeyframe: false, microseconds: 80_000 })
    await new Promise((r) => setTimeout(r, 50))
    const bytes = Buffer.concat(received)
    // RFC 4571: a 16-bit big-endian length precedes each RTP packet; the RTP
    // version bits (10) sit in the first payload byte.
    expect(bytes.length).toBeGreaterThan(4)
    expect(bytes.readUInt16BE(0)).toBeGreaterThan(0)
    expect(bytes[2]! >> 6).toBe(2)

    client.destroy()
    await new Promise((r) => setTimeout(r, 80))
    expect(disconnected).toBe(1)
    await rfc.close()
  })

  it('stops the feed and throws when no keyframe arrives in time', async () => {
    const feed = new FakeFeed()
    await expect(
      startRfc4571Server({
        stream: feed,
        logger: silentLogger(),
        bindHost: '127.0.0.1',
        keyframeTimeoutMs: 30,
        onConsumerDisconnect: () => undefined,
        onFeedLost: () => undefined,
      }),
    ).rejects.toThrow(/first keyframe/)
    expect(feed.stopped).toBe(1)
  })
})

/**
 * The relay dies in three ways nodedreame reports and one it cannot: the
 * client socket errors (`error` — on 2026-09-09 a `read ETIMEDOUT` with no
 * listener took the whole provider down), the relay closes and the stream
 * stops itself (`stopped`), or the socket simply goes silent for minutes
 * before the kernel gives up (nothing at all — 16 min of a broker dialling a
 * port that accepted and sent nothing). The server owns the feed, so it is
 * the one that says "the feed is gone" — once, and never for its own close.
 */
describe('startRfc4571Server — a lost feed is REPORTED, never a crash and never silence', () => {
  async function openServer(opts: { stallTimeoutMs?: number } = {}) {
    const feed = new FakeFeed()
    const losses: FeedLoss[] = []
    const starting = startRfc4571Server({
      stream: feed,
      logger: silentLogger(),
      bindHost: '127.0.0.1',
      audioGraceMs: 10,
      idleGraceMs: 30,
      onConsumerDisconnect: () => undefined,
      onFeedLost: (loss) => {
        losses.push(loss)
      },
      ...(opts.stallTimeoutMs !== undefined ? { stallTimeoutMs: opts.stallTimeoutMs } : {}),
    })
    setTimeout(
      () => feed.emit('videoAccessUnit', { data: keyframe, isKeyframe: true, microseconds: 0 }),
      5,
    )
    const rfc = await starting
    return { feed, losses, rfc }
  }

  it('a feed error after the server is up is reported once with the error — and does not throw', async () => {
    const { feed, losses, rfc } = await openServer()
    const err = new Error('read ETIMEDOUT')
    // With no listener an EventEmitter THROWS here: this line is the crash.
    expect(() => feed.emit('error', err)).not.toThrow()
    feed.emit('error', new Error('a second one'))
    expect(losses).toEqual([{ reason: 'error', error: err }])
    await rfc.close()
  })

  it('a feed that stopped on its own (the relay closed) is reported as stopped', async () => {
    const { feed, losses, rfc } = await openServer()
    feed.emit('stopped')
    expect(losses).toEqual([{ reason: 'stopped', error: null }])
    await rfc.close()
  })

  it('a feed that goes silent past the stall window is reported as stalled; one that keeps sending is not', async () => {
    const { feed, losses, rfc } = await openServer({ stallTimeoutMs: 60 })
    // Frames keep coming for a while: no loss.
    for (let i = 0; i < 4; i += 1) {
      feed.emit('videoAccessUnit', {
        data: pframe,
        isKeyframe: false,
        microseconds: (i + 1) * 40_000,
      })
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(losses).toEqual([])
    // Then silence.
    await new Promise((r) => setTimeout(r, 160))
    expect(losses).toEqual([{ reason: 'stalled', error: null }])
    await rfc.close()
  })

  it('our own close is not a loss — the stopped the feed then emits is ours', async () => {
    const { feed, losses, rfc } = await openServer({ stallTimeoutMs: 40 })
    await rfc.close()
    feed.emit('stopped')
    await new Promise((r) => setTimeout(r, 120))
    expect(losses).toEqual([])
  })

  it('a feed error BEFORE the first keyframe fails the open at once, instead of waiting out the keyframe timeout', async () => {
    const feed = new FakeFeed()
    const startedAt = Date.now()
    const starting = startRfc4571Server({
      stream: feed,
      logger: silentLogger(),
      bindHost: '127.0.0.1',
      keyframeTimeoutMs: 5_000,
      onConsumerDisconnect: () => undefined,
      onFeedLost: () => undefined,
    })
    setTimeout(() => feed.emit('error', new Error('relay refused')), 5)
    await expect(starting).rejects.toThrow(/relay refused/)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(feed.stopped).toBe(1)
  })
})

/**
 * The audio decision was made once, in a 1.5 s race after the first keyframe,
 * and NOTHING recorded the outcome. If the first AAC frame was late the SDP
 * was built without audio and the `audioFrame` handler was never attached — so
 * the session stayed mute for its whole life even when audio began flowing a
 * moment later. Twelve hours of hub logs could not say whether that was
 * happening, because the branch that drops the audio wrote no line at all.
 */
describe('startRfc4571Server: the audio decision is never silent', () => {
  it('says so when it gives up on audio and serves video-only', async () => {
    const feed = new FakeFeed()
    const lines: Recorded[] = []
    const starting = startRfc4571Server({
      stream: feed,
      logger: recordingLogger(lines),
      bindHost: '127.0.0.1',
      audioGraceMs: 20,
      idleGraceMs: 30,
      onConsumerDisconnect: () => undefined,
      onFeedLost: () => undefined,
    })
    setTimeout(
      () => feed.emit('videoAccessUnit', { data: keyframe, isKeyframe: true, microseconds: 0 }),
      5,
    )
    const rfc = await starting
    expect(rfc.audio).toBeNull()

    const said = lines.find((l) => /video-only|no audio/i.test(l.message))
    expect(said, 'the session went mute and wrote no line about it').toBeDefined()
    expect(said?.meta?.waitedMs, 'the line does not say how long it waited').toBeDefined()
    await rfc.close()
  })

  it('records the audio it DID find, with the format it will serve', async () => {
    const feed = new FakeFeed()
    const lines: Recorded[] = []
    const starting = startRfc4571Server({
      stream: feed,
      logger: recordingLogger(lines),
      bindHost: '127.0.0.1',
      audioGraceMs: 200,
      idleGraceMs: 30,
      onConsumerDisconnect: () => undefined,
      onFeedLost: () => undefined,
    })
    setTimeout(() => {
      feed.emit('videoAccessUnit', { data: keyframe, isKeyframe: true, microseconds: 0 })
      feed.emit('audioFrame', ADTS)
    }, 5)
    const rfc = await starting
    expect(rfc.audio).not.toBeNull()

    const said = lines.find((l) => /audio/i.test(l.message) && l.meta?.sampleRate !== undefined)
    expect(said, 'the served audio format was never recorded').toBeDefined()
    expect(said?.meta?.sampleRate).toBe(44100)
    expect(said?.meta?.channels).toBe(2)
    await rfc.close()
  })

  it('reports audio that arrived AFTER the grace, instead of dropping it in silence', async () => {
    const feed = new FakeFeed()
    const lines: Recorded[] = []
    const starting = startRfc4571Server({
      stream: feed,
      logger: recordingLogger(lines),
      bindHost: '127.0.0.1',
      audioGraceMs: 20,
      idleGraceMs: 30,
      onConsumerDisconnect: () => undefined,
      onFeedLost: () => undefined,
    })
    setTimeout(
      () => feed.emit('videoAccessUnit', { data: keyframe, isKeyframe: true, microseconds: 0 }),
      5,
    )
    const rfc = await starting
    expect(rfc.audio).toBeNull()

    // The robot's audio starts a moment after the video. This is the decisive
    // evidence that the grace window — not a missing microphone — is what
    // muted the session, and it is exactly what the logs could not tell us.
    feed.emit('audioFrame', ADTS)
    await new Promise((r) => setTimeout(r, 20))

    const late = lines.find((l) => /late|after the grace/i.test(l.message))
    expect(late, 'audio arrived after the grace and nothing said so').toBeDefined()
    expect(late?.level).toBe('warn')
    await rfc.close()
  })
})

/**
 * Knowing the FIRST audio frame arrived says nothing about the session. The
 * hub could see `serving audio {waitedMs=0}` on a robot the operator heard
 * nothing from, because the relay counted no frames and reported no flow: a
 * stream that emits one AAC frame and then stops looks identical, from the
 * log, to one that plays for ten minutes.
 */
describe('startRfc4571Server: audio FLOW, not just the first frame', () => {
  async function serving(lines: Recorded[], stallTimeoutMs = 10_000) {
    const feed = new FakeFeed()
    const starting = startRfc4571Server({
      stream: feed,
      logger: recordingLogger(lines),
      bindHost: '127.0.0.1',
      audioGraceMs: 200,
      idleGraceMs: 30,
      stallTimeoutMs,
      onConsumerDisconnect: () => undefined,
      onFeedLost: () => undefined,
    })
    setTimeout(() => {
      feed.emit('videoAccessUnit', { data: keyframe, isKeyframe: true, microseconds: 0 })
      feed.emit('audioFrame', ADTS)
    }, 5)
    return { feed, rfc: await starting }
  }

  it('reports how many audio frames actually flowed when the session ends', async () => {
    const lines: Recorded[] = []
    const { feed, rfc } = await serving(lines)
    for (let i = 0; i < 4; i++) feed.emit('audioFrame', ADTS)
    feed.emit('videoAccessUnit', { data: pframe, isKeyframe: false, microseconds: 40_000 })
    await rfc.close()

    const summary = lines.find((l) => l.meta?.audioFrames !== undefined)
    expect(summary, 'the session ended without saying whether audio ever flowed').toBeDefined()
    expect(Number(summary?.meta?.audioFrames)).toBeGreaterThanOrEqual(4)
    expect(summary?.meta?.videoAccessUnits).toBeDefined()
  })

  it('warns when the audio dies mid-session while the video keeps going', async () => {
    const lines: Recorded[] = []
    const { feed, rfc } = await serving(lines, 40)
    feed.emit('audioFrame', ADTS)
    // Video keeps the feed alive, so this is not a lost relay: it is a stream
    // that went mute on its own — the shape an operator reports as "no audio".
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 15))
      feed.emit('videoAccessUnit', { data: pframe, isKeyframe: false, microseconds: i * 40_000 })
    }
    const stalled = lines.find((l) => /audio stopped|audio stalled/i.test(l.message))
    expect(stalled, 'the audio stopped and nothing said so').toBeDefined()
    expect(stalled?.level).toBe('warn')
    await rfc.close()
  })
})
