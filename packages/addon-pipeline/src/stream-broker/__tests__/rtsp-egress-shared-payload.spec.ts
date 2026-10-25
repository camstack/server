/**
 * Stage 1 — the per-client packet copy, and the join-window allocation burst.
 *
 * Both are ALLOCATION facts, so both are asserted positively: identity of the
 * buffer that reaches the socket, and a call count on the ring supplier. An
 * absence ("no copy happened") is not observable and would pass with the
 * mechanism switched off.
 */
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import { RtspSession } from '../rtsp/rtsp-session.js'

const activeSockets: Array<{ destroy: () => void }> = []

afterEach(() => {
  for (const s of activeSockets) s.destroy()
  activeSockets.length = 0
})

interface MockSocket {
  readonly socket: Socket
  /** Every chunk BY REFERENCE — never copied, because identity is the assertion. */
  readonly written: unknown[]
}

function createMockSocket(): MockSocket {
  const written: unknown[] = []
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    write(chunk: Buffer | string): boolean {
      written.push(chunk)
      return true
    },
    cork() {
      /* no-op */
    },
    uncork() {
      /* no-op */
    },
    destroy: vi.fn(),
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

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

function playSession(restreamer: RtspRestreamer, mock: MockSocket): RtspSession {
  const session = new RtspSession(mock.socket, SDP, undefined, false)
  restreamer.addSession(session)
  mock.socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/t/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  mock.socket.emit('data', Buffer.from('PLAY rtsp://localhost/t RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
  mock.written.length = 0
  return session
}

/** An RTP packet whose NAL byte marks a keyframe (IDR, type 5). */
function keyframeRtp(ts: number): Buffer {
  const pkt = Buffer.alloc(20)
  pkt[0] = 0x80
  pkt[1] = 0xe0 // PT=96, marker set
  pkt.writeUInt32BE(ts >>> 0, 4)
  pkt[12] = 0x65
  return pkt
}

describe('interleaved egress — N clients cause ONE payload allocation', () => {
  it('writes the SAME payload object to every connected session', () => {
    const restreamer = new RtspRestreamer('shared-payload')
    restreamer.setCameraSdp(SDP, 'h264', null)

    const a = createMockSocket()
    const b = createMockSocket()
    const c = createMockSocket()
    playSession(restreamer, a)
    playSession(restreamer, b)
    playSession(restreamer, c)

    const packet = keyframeRtp(9000)
    restreamer.pushRtpPassthrough(packet, true, false)

    // THE assertion: the payload each socket received is the very buffer the
    // broker holds — not a per-client copy of it. `toBe` is reference identity.
    for (const mock of [a, b, c]) {
      const payloads = mock.written.filter((chunk) => chunk === packet)
      expect(payloads.length).toBeGreaterThan(0)
    }

    // And the header is a FRESH allocation per write, never a shared scratch
    // buffer: two sessions must not have been handed the same header object,
    // because a reused header would be rewritten under an in-flight write.
    const headerOf = (mock: MockSocket): unknown =>
      mock.written.find(
        (chunk) => Buffer.isBuffer(chunk) && chunk.length === 4 && chunk[0] === 0x24,
      )
    expect(headerOf(a)).toBeDefined()
    expect(headerOf(a)).not.toBe(headerOf(b))
    expect(headerOf(b)).not.toBe(headerOf(c))
  })

  it('the header carries the interleave channel and the payload length', () => {
    const restreamer = new RtspRestreamer('header-shape')
    restreamer.setCameraSdp(SDP, 'h264', null)
    const a = createMockSocket()
    playSession(restreamer, a)

    const packet = keyframeRtp(9000)
    restreamer.pushRtpPassthrough(packet, true, false)

    const header = a.written.find(
      (chunk): chunk is Buffer => Buffer.isBuffer(chunk) && chunk.length === 4 && chunk[0] === 0x24,
    )
    expect(header).toBeDefined()
    expect(header?.[1]).toBe(0)
    expect(header?.readUInt16BE(2)).toBe(packet.length)
  })
})

describe('join window — the ring is not mapped when nobody is ready', () => {
  it('does NOT consult the ring supplier while a session sits between SETUP and PLAY', () => {
    const restreamer = new RtspRestreamer('join-burst')
    restreamer.setCameraSdp(SDP, 'h264', null)

    const ring = [keyframeRtp(1), keyframeRtp(2), keyframeRtp(3)]
    const supplier = vi.fn(() => ring)
    restreamer.setRtpPreBufferSupplier(supplier)

    // SETUP only — the session is pending, never PLAYing.
    const mock = createMockSocket()
    const session = new RtspSession(mock.socket, SDP, undefined, false)
    restreamer.addSession(session)
    mock.socket.emit(
      'data',
      Buffer.from(
        'SETUP rtsp://localhost/t/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
      ),
    )

    for (let i = 0; i < 40; i++) restreamer.pushRtpPassthrough(keyframeRtp(100 + i), true, false)

    // Positive fact with the mechanism ON: zero ring maps across 40 packets.
    // Before the hoist this was 40 — one full ring map per incoming packet, for
    // the whole SETUP→PLAY window, on every motion-driven detection dial.
    expect(supplier).toHaveBeenCalledTimes(0)

    // ...and the supplier IS consulted once the session plays, so the zero above
    // is the early exit and not a supplier that was never wired.
    mock.socket.emit('data', Buffer.from('PLAY rtsp://localhost/t RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
    restreamer.pushRtpPassthrough(keyframeRtp(200), true, false)
    expect(supplier.mock.calls.length).toBeGreaterThan(0)
  })
})
