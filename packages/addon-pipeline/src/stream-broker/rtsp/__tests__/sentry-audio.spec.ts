/**
 * A SENTRY session keeps the camera's AUDIO.
 *
 * The defect these specs close: `/sentry` was parsed as `muted: true`, so the
 * listen server handed it `getMutedSdp()` — an SDP with no `m=audio` line at
 * all. RTSP cannot renegotiate mid-session, so that decision, taken at URL
 * parse time from a string, could never be revisited: a sentry consumer could
 * not receive the camera's audio when the camera woke, ever.
 *
 * The comment that defended it was right about the hazard and wrong about the
 * remedy — "an `m=audio` nobody fills stalls a consumer's ffmpeg". The answer
 * is to FILL it: silence while the camera sleeps and the courtesy picture is
 * being served, the camera's real audio the instant media flows, and never
 * both at once.
 *
 * The mute belongs to the PLACEHOLDER, not to the path. (D525)
 */
import { EventEmitter } from 'node:events'
import * as net from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IScopedLogger } from '@camstack/types'

import {
  G711_FRAME_MS,
  G711_FRAME_SAMPLES,
  buildG711SilenceRtp,
  g711AudioMediaBlock,
  g711TrackFor,
  type G711AudioTrack,
} from '../audio/g711-silence.js'
import {
  DETECTION_MUTED_PATH_SUFFIX,
  MUTED_PATH_SUFFIX,
  RECORDING_PATH_SUFFIX,
  SENTRY_PATH_SUFFIX,
  isLiveEdgeOnlyDial,
  parseRestreamPath,
  sdpVariantFor,
} from '../restream-intent.js'
import { RtspListenServer } from '../rtsp-listen-server.js'
import { RtspRestreamer } from '../rtsp-restreamer.js'
import { RtspSession } from '../rtsp-session.js'

const TOKEN = 'c1609d0c9ec63e76852da48e3be1593e'
const BROKER = '106/native:main'

const SENTRY_DECL = parseRestreamPath(`${TOKEN}${SENTRY_PATH_SUFFIX}`).declaration
const PCMU: G711AudioTrack = {
  codec: 'PCMU',
  payloadType: 0,
  clockRateHz: 8000,
  channels: 1,
}

/** The video-only SDP the placeholder path builds while the camera sleeps. */
const PLACEHOLDER_SDP =
  'v=0\r\ns=cam\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'
/** The camera's OWN SDP, which already describes its audio track. */
const CAMERA_SDP =
  'v=0\r\ns=cam\r\nt=0 0\r\n' +
  'm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n' +
  'm=audio 0 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=control:trackID=1\r\n'

const activeSockets: Array<{ destroy: () => void }> = []

afterEach(() => {
  for (const s of activeSockets) s.destroy()
  activeSockets.length = 0
  vi.useRealTimers()
})

interface MockSocket {
  readonly socket: Socket
  readonly written: Buffer[]
}

function createMockSocket(): MockSocket {
  const written: Buffer[] = []
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    write(chunk: Buffer | string): boolean {
      written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk))
      return true
    },
    cork() {
      /* the mock records each chunk as the peer would see it */
    },
    uncork() {
      /* no-op */
    },
    destroy: vi.fn(),
    unshift(_chunk: Buffer) {
      /* no-op */
    },
    get writableLength() {
      return 0
    },
    get destroyed() {
      return false
    },
  }) as unknown as Socket
  activeSockets.push(socket)
  return { socket, written }
}

/** One `$ <channel> <len> <payload>` record the peer saw, rejoined. */
interface InterleavedRecord {
  readonly channel: number
  readonly payload: Buffer
}

function interleavedRecords(written: readonly Buffer[]): readonly InterleavedRecord[] {
  const out: InterleavedRecord[] = []
  for (let i = 0; i < written.length; i++) {
    const head = written[i]
    if (head === undefined || head.length !== 4 || head[0] !== 0x24) continue
    const payload = written[i + 1]
    if (payload === undefined) continue
    out.push({ channel: head[1]!, payload })
    i++
  }
  return out
}

/** The audio track is SETUP second, so it lands on interleaved channel 2. */
const AUDIO_CHANNEL = 2

function audioRecords(written: readonly Buffer[]): readonly Buffer[] {
  return interleavedRecords(written)
    .filter((r) => r.channel === AUDIO_CHANNEL)
    .map((r) => r.payload)
}

/** Drive a session through SETUP(video) + SETUP(audio) + PLAY. */
function playAudioSession(
  restreamer: RtspRestreamer,
  mock: MockSocket,
  session: RtspSession,
): void {
  restreamer.addSession(session)
  mock.socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/t/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  mock.socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/t/trackID=1 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=2-3\r\n\r\n',
    ),
  )
  mock.socket.emit('data', Buffer.from('PLAY rtsp://localhost/t RTSP/1.0\r\nCSeq: 3\r\n\r\n'))
  mock.written.length = 0
}

/** A video RTP packet with the given 90 kHz timestamp. */
function videoRtp(ts: number): Buffer {
  const pkt = Buffer.alloc(20)
  pkt[0] = 0x80
  pkt[1] = 0x60
  pkt.writeUInt32BE(ts >>> 0, 4)
  return pkt
}

/**
 * Clear a session's `pendingKeyframe` latch by serving it a video join burst.
 *
 * The camera's REAL audio is held behind that latch (`pushAudioRtpPassthrough`
 * skips a session still waiting for its first keyframe), so a transition test
 * that never fed video would be measuring the latch, not the handover.
 */
function serveVideoKeyframe(restreamer: RtspRestreamer): void {
  restreamer.pushRtpPassthrough(videoRtp(90_000), true, false)
  restreamer.pushRtpPassthrough(videoRtp(90_900), false, false)
  vi.advanceTimersByTime(200)
}

/** A real camera audio RTP packet: PT 0, 160 µ-law bytes that are NOT silence. */
function realAudioRtp(seq: number, ts: number): Buffer {
  const pkt = Buffer.alloc(12 + G711_FRAME_SAMPLES, 0x12)
  pkt[0] = 0x80
  pkt[1] = 0x00
  pkt.writeUInt16BE(seq & 0xffff, 2)
  pkt.writeUInt32BE(ts >>> 0, 4)
  pkt.writeUInt32BE(0xdeadbeef, 8)
  return pkt
}

/** A no-cast `IScopedLogger` whose `info` is the spy under test. */
function makeLogger(info: IScopedLogger['info']): IScopedLogger {
  const logger: IScopedLogger = {
    info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
    withTags: vi.fn(() => logger),
  }
  return logger
}

/** Is this RTP payload our generated µ-law silence? */
function isSilencePayload(rtp: Buffer): boolean {
  const payload = rtp.subarray(12)
  return payload.length > 0 && payload.every((b) => b === 0xff)
}

// ── 1. The path stops deciding the mute ──────────────────────────────────

describe('the sentry dial is not muted', () => {
  it('keeps its audio — the mute belonged to the placeholder, not the path', () => {
    expect(parseRestreamPath(`${TOKEN}${SENTRY_PATH_SUFFIX}`).muted).toBe(false)
  })

  it('still resolves to the profile token and declares the sentry intent', () => {
    const parsed = parseRestreamPath(`${TOKEN}${SENTRY_PATH_SUFFIX}`)
    expect(parsed.lookupPath).toBe(TOKEN)
    expect(parsed.declaration.intent).toBe('sentry')
  })

  it('asks the listen server for the SENTRY sdp variant, not the full one', () => {
    expect(sdpVariantFor(parseRestreamPath(`${TOKEN}${SENTRY_PATH_SUFFIX}`))).toBe('sentry')
    expect(sdpVariantFor(parseRestreamPath(`${TOKEN}${MUTED_PATH_SUFFIX}`))).toBe('muted')
    expect(sdpVariantFor(parseRestreamPath(TOKEN))).toBe('full')
  })
})

// ── 2. isMuted() had two jobs. They are now two predicates. ──────────────

describe('the live-edge join rule is its own predicate', () => {
  it('still holds for the sentry — un-muting it must not change its join', () => {
    expect(isLiveEdgeOnlyDial(parseRestreamPath(`${TOKEN}${SENTRY_PATH_SUFFIX}`))).toBe(true)
  })

  it('still holds for /muted — the HomeKit/ffmpeg re-clocking leg', () => {
    expect(isLiveEdgeOnlyDial(parseRestreamPath(`${TOKEN}${MUTED_PATH_SUFFIX}`))).toBe(true)
  })

  it('does NOT hold for the detection dial — it drains the burst (D193)', () => {
    expect(isLiveEdgeOnlyDial(parseRestreamPath(`${TOKEN}${DETECTION_MUTED_PATH_SUFFIX}`))).toBe(
      false,
    )
  })

  it('does NOT hold for a recording dial or a plain one', () => {
    expect(isLiveEdgeOnlyDial(parseRestreamPath(`${TOKEN}${RECORDING_PATH_SUFFIX}`))).toBe(false)
    expect(isLiveEdgeOnlyDial(parseRestreamPath(TOKEN))).toBe(false)
  })

  it('a sentry SESSION reports both facts apart', () => {
    const mock = createMockSocket()
    const session = new RtspSession(mock.socket, PLACEHOLDER_SDP, undefined, false, SENTRY_DECL)
    expect(session.isMuted()).toBe(false)
    expect(session.isLiveEdgeOnly()).toBe(true)
    expect(session.isPrestreamIntent()).toBe(true)
  })
})

// ── 3. The silence bytes themselves ──────────────────────────────────────

describe('G.711 silence', () => {
  it('is exact — µ-law digital zero is 0xFF, A-law 0xD5', () => {
    const pcmu = buildG711SilenceRtp({
      track: PCMU,
      ssrc: 1,
      sequenceNumber: 7,
      rtpTimestamp: 160,
      marker: true,
    })
    expect(pcmu.subarray(12).every((b) => b === 0xff)).toBe(true)
    const pcma = buildG711SilenceRtp({
      track: g711TrackFor('PCMA')!,
      ssrc: 1,
      sequenceNumber: 7,
      rtpTimestamp: 160,
      marker: false,
    })
    expect(pcma.subarray(12).every((b) => b === 0xd5)).toBe(true)
  })

  it('carries the track’s payload type, the sequence and the timestamp', () => {
    const rtp = buildG711SilenceRtp({
      track: PCMU,
      ssrc: 0x11223344,
      sequenceNumber: 9,
      rtpTimestamp: 320,
      marker: true,
    })
    expect(rtp[0]).toBe(0x80)
    expect(rtp[1]! & 0x7f).toBe(0)
    expect((rtp[1]! & 0x80) !== 0).toBe(true)
    expect(rtp.readUInt16BE(2)).toBe(9)
    expect(rtp.readUInt32BE(4)).toBe(320)
    expect(rtp.readUInt32BE(8)).toBe(0x11223344)
    expect(rtp.length).toBe(12 + G711_FRAME_SAMPLES)
  })

  it('refuses a codec it cannot fill exactly — never a guessed default', () => {
    expect(g711TrackFor('PCMU')).not.toBeNull()
    expect(g711TrackFor('pcma')).not.toBeNull()
    expect(g711TrackFor('MPEG4-GENERIC')).toBeNull()
    expect(g711TrackFor('opus')).toBeNull()
    expect(g711TrackFor(undefined)).toBeNull()
  })

  it('describes itself as a static-payload media block the camera will match', () => {
    const block = g711AudioMediaBlock(PCMU, 1)
    expect(block).toContain('m=audio 0 RTP/AVP 0')
    expect(block).toContain('a=rtpmap:0 PCMU/8000')
    expect(block).toContain('a=control:trackID=1')
  })
})

// ── 4. The SDP the sentry is handed ──────────────────────────────────────

describe('the sentry SDP', () => {
  it('carries m=audio while the camera sleeps, from the retained track', () => {
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)
    restreamer.retainSentryAudioTrack(PCMU)
    // The camera goes back to sleep: the connection's SDP is wiped.
    restreamer.resetStreamState()
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)

    const sentry = restreamer.getSdpFor('sentry') ?? ''
    expect(sentry).toContain('m=audio')
    expect(sentry).toContain('a=rtpmap:0 PCMU/8000')
    // And nobody else's SDP moved.
    expect(restreamer.getSdpFor('muted')).not.toContain('m=audio')
    expect(restreamer.getSdpFor('full')).toBe(PLACEHOLDER_SDP)
  })

  it('retains the track across a suspend — a sleeping camera has no SDP to read', () => {
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.resetStreamState()
    expect(restreamer.getSentryAudioTrack()).toEqual(PCMU)
  })

  it('uses the camera’s OWN audio description once the camera is up', () => {
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)
    // Not a graft on top of the real one: exactly one m=audio.
    const sentry = restreamer.getSdpFor('sentry') ?? ''
    expect(sentry.match(/^m=audio/gm)?.length).toBe(1)
    expect(sentry).toBe(CAMERA_SDP)
  })

  it('offers no audio when nothing has ever described this camera’s audio', () => {
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)
    expect(restreamer.getSdpFor('sentry')).not.toContain('m=audio')
  })

  it('obeys the operator’s broker-side mute — that one IS a device policy', () => {
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)
    restreamer.setAudioMuted(true)
    expect(restreamer.getSdpFor('sentry')).not.toContain('m=audio')
  })
})

// ── 5. THE TRANSITION, both directions, and the overlap ──────────────────

describe('silence while asleep, real audio on wake, never both', () => {
  it('fills the sentry’s audio track with silence while the camera sleeps', () => {
    vi.useFakeTimers()
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)

    const mock = createMockSocket()
    playAudioSession(
      restreamer,
      mock,
      new RtspSession(mock.socket, PLACEHOLDER_SDP, undefined, false, SENTRY_DECL),
    )

    vi.advanceTimersByTime(G711_FRAME_MS * 10)
    const audio = audioRecords(mock.written)
    expect(audio.length).toBeGreaterThanOrEqual(5)
    expect(audio.every(isSilencePayload)).toBe(true)
  })

  it('advances the RTP timestamp by one frame per packet and the sequence by one', () => {
    vi.useFakeTimers()
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)

    const mock = createMockSocket()
    playAudioSession(
      restreamer,
      mock,
      new RtspSession(mock.socket, PLACEHOLDER_SDP, undefined, false, SENTRY_DECL),
    )
    vi.advanceTimersByTime(G711_FRAME_MS * 5)

    const audio = audioRecords(mock.written)
    expect(audio.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < audio.length; i++) {
      const prev = audio[i - 1]!
      const cur = audio[i]!
      expect(cur.readUInt16BE(2)).toBe((prev.readUInt16BE(2) + 1) & 0xffff)
      expect(cur.readUInt32BE(4)).toBe((prev.readUInt32BE(4) + G711_FRAME_SAMPLES) >>> 0)
    }
  })

  it('stops the INSTANT real audio arrives, and never overlaps it', () => {
    vi.useFakeTimers()
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)

    const mock = createMockSocket()
    playAudioSession(
      restreamer,
      mock,
      new RtspSession(mock.socket, PLACEHOLDER_SDP, undefined, false, SENTRY_DECL),
    )
    vi.advanceTimersByTime(G711_FRAME_MS * 5)
    expect(audioRecords(mock.written).some(isSilencePayload)).toBe(true)

    // The camera wakes: real media flows. Video first, exactly as it does on
    // the wire — the audio path is latched behind the first keyframe.
    serveVideoKeyframe(restreamer)
    mock.written.length = 0
    restreamer.pushAudioRtpPassthrough(realAudioRtp(1, 1000))
    vi.advanceTimersByTime(G711_FRAME_MS * 20)
    restreamer.pushAudioRtpPassthrough(realAudioRtp(2, 1160))
    vi.advanceTimersByTime(G711_FRAME_MS * 20)

    const after = audioRecords(mock.written)
    // The sentry received the camera's REAL audio — the whole point.
    expect(after.filter((p) => !isSilencePayload(p)).length).toBe(2)
    // And not one generated frame after the first real one.
    expect(after.filter(isSilencePayload)).toHaveLength(0)
  })

  it('resumes silence when the camera goes quiet again — the track stays filled', () => {
    vi.useFakeTimers()
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)

    const mock = createMockSocket()
    playAudioSession(
      restreamer,
      mock,
      new RtspSession(mock.socket, PLACEHOLDER_SDP, undefined, false, SENTRY_DECL),
    )
    restreamer.pushAudioRtpPassthrough(realAudioRtp(1, 1000))
    mock.written.length = 0

    // Inside the resume gap: still nothing generated.
    vi.advanceTimersByTime(200)
    expect(audioRecords(mock.written)).toHaveLength(0)

    // Past it: the placeholder takes the track back.
    vi.advanceTimersByTime(2_000)
    const resumed = audioRecords(mock.written)
    expect(resumed.length).toBeGreaterThan(0)
    expect(resumed.every(isSilencePayload)).toBe(true)
  })

  it('never sends silence to a session that is not a sentry', () => {
    vi.useFakeTimers()
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)

    const plain = createMockSocket()
    playAudioSession(restreamer, plain, new RtspSession(plain.socket, CAMERA_SDP, undefined, false))
    const sentry = createMockSocket()
    playAudioSession(
      restreamer,
      sentry,
      new RtspSession(sentry.socket, CAMERA_SDP, undefined, false, SENTRY_DECL),
    )

    vi.advanceTimersByTime(G711_FRAME_MS * 10)
    expect(audioRecords(plain.written)).toHaveLength(0)
    expect(audioRecords(sentry.written).length).toBeGreaterThan(0)
  })

  it('generates nothing at all when no sentry session is attached', () => {
    vi.useFakeTimers()
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)
    const mock = createMockSocket()
    playAudioSession(
      restreamer,
      mock,
      new RtspSession(mock.socket, PLACEHOLDER_SDP, undefined, false),
    )
    vi.advanceTimersByTime(G711_FRAME_MS * 20)
    expect(audioRecords(mock.written)).toHaveLength(0)
  })

  it('generates nothing once the last sentry session leaves', () => {
    vi.useFakeTimers()
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)
    const mock = createMockSocket()
    const session = new RtspSession(mock.socket, PLACEHOLDER_SDP, undefined, false, SENTRY_DECL)
    playAudioSession(restreamer, mock, session)
    vi.advanceTimersByTime(G711_FRAME_MS * 5)
    expect(audioRecords(mock.written).length).toBeGreaterThan(0)

    expect(restreamer.isSentryAudioFilling()).toBe(true)

    restreamer.removeSession(session.getSessionId())
    mock.written.length = 0
    vi.advanceTimersByTime(G711_FRAME_MS * 20)
    expect(audioRecords(mock.written)).toHaveLength(0)
    // The assertion that matters. A filler whose last consumer has gone writes
    // to nobody either way, so a quiet socket proves nothing — the timer is
    // what has to be gone, or every broker that ever served a sentry keeps a
    // 50 Hz interval for the life of the process.
    expect(restreamer.isSentryAudioFilling()).toBe(false)
  })

  it('leaves no timer behind when the restreamer is destroyed', () => {
    // `destroy()` clears the session map directly instead of going through
    // `removeSession`, so the reconcile that stops the filler never runs there.
    vi.useFakeTimers()
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)
    const mock = createMockSocket()
    playAudioSession(
      restreamer,
      mock,
      new RtspSession(mock.socket, PLACEHOLDER_SDP, undefined, false, SENTRY_DECL),
    )
    expect(restreamer.isSentryAudioFilling()).toBe(true)

    restreamer.destroy()
    expect(restreamer.isSentryAudioFilling()).toBe(false)
  })

  it('says so when a sentry attaches with no audio track to fill', () => {
    vi.useFakeTimers()
    const restreamer = new RtspRestreamer(BROKER)
    const info = vi.fn()
    restreamer.setLogger(makeLogger(info))
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)

    const mock = createMockSocket()
    playAudioSession(
      restreamer,
      mock,
      new RtspSession(mock.socket, PLACEHOLDER_SDP, undefined, false, SENTRY_DECL),
    )

    const line = info.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('sentry audio'),
    )
    expect(line).toBeDefined()
    expect(line?.[1]).toMatchObject({ tags: { deviceId: 106 } })
  })
})

// ── 6. What the consumer is actually handed, over the wire ───────────────

/**
 * The gap a unit test on `getSentrySdp()` cannot close: the listen server
 * chooses the variant, and it used to choose from the mute bit. A DESCRIBE that
 * returns a video-only SDP is the whole defect, and it is invisible to every
 * assertion that calls the restreamer directly.
 */
describe('a sentry DESCRIBE is answered with the audio track', () => {
  async function describeOnce(port: number, path: string): Promise<string> {
    return new Promise<string>((resolve) => {
      let body = ''
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          `DESCRIBE rtsp://127.0.0.1:${port}/${path} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: vitest\r\n\r\n`,
        )
      })
      socket.on('data', (b) => {
        body += b.toString()
        socket.destroy()
        resolve(body)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(body)
      })
      setTimeout(() => {
        socket.destroy()
        resolve(body)
      }, 2_000).unref?.()
    })
  }

  it('announces m=audio to /sentry and to nobody else', async () => {
    const restreamer = new RtspRestreamer(BROKER)
    restreamer.retainSentryAudioTrack(PCMU)
    restreamer.setCameraSdp(PLACEHOLDER_SDP, 'h264', null)

    const server = new RtspListenServer()
    server.registerRestreamer(BROKER, restreamer, undefined, TOKEN, () => () => {})
    await server.start(0)
    try {
      const sentry = await describeOnce(server.getPort(), `${TOKEN}${SENTRY_PATH_SUFFIX}`)
      expect(sentry).toContain('RTSP/1.0 200')
      expect(sentry).toContain('m=audio 0 RTP/AVP 0')
      expect(sentry).toContain('a=rtpmap:0 PCMU/8000')

      const muted = await describeOnce(server.getPort(), `${TOKEN}${MUTED_PATH_SUFFIX}`)
      expect(muted).not.toContain('m=audio')
    } finally {
      await server.stop()
    }
  })
})
