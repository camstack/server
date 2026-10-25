import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RtspSession } from '../rtsp/rtsp-session.js'
import { MAX_WRITE_BUFFER, type RtpPacket } from '../rtsp/rtsp-types.js'

/**
 * An RTSP session corks its socket per ACCESS UNIT, not per packet.
 *
 * `writeInterleaved` corked around every `header + payload` pair — one
 * `cork`/`uncork` and one `writev` per RTP packet per session. A 4K keyframe
 * fragmented into a hundred packets, fanned out to three sessions, was three
 * hundred syscalls for one picture a decoder cannot use before it is whole.
 * The socket is now corked on the first write of an access unit and uncorked
 * on the packet that ENDS it (the RTP marker), with a `process.nextTick`
 * safety net so a marker-less camera, or a lost marker, never leaves the
 * socket corked across I/O.
 *
 * Backpressure is untouched: `writableLength` counts corked bytes too, so the
 * `MAX_WRITE_BUFFER` gate, the drop-until-keyframe latch and the
 * `MAX_MISSED_KEYFRAMES` close (D447) judge exactly what they judged before.
 */

interface CorkCountingSocket {
  readonly socket: Socket
  readonly written: Buffer[]
  readonly corks: () => number
  readonly uncorks: () => number
  setBacklogged: (backlogged: boolean) => void
}

const sockets: CorkCountingSocket[] = []

afterEach(() => {
  for (const s of sockets) s.socket.destroy()
  sockets.length = 0
})

function createCorkCountingSocket(): CorkCountingSocket {
  const written: Buffer[] = []
  let corks = 0
  let uncorks = 0
  let backlogged = false
  const emitter = new EventEmitter()
  const base = Object.assign(emitter, {
    write(chunk: Buffer | string): boolean {
      written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk))
      return true
    },
    cork() {
      corks++
    },
    uncork() {
      uncorks++
    },
    destroy: vi.fn(),
    unshift(_chunk: Buffer) {},
    remoteAddress: '127.0.0.1',
    remotePort: 55555,
  })
  Object.defineProperty(base, 'writableLength', {
    get: () => (backlogged ? MAX_WRITE_BUFFER + 1 : 0),
  })
  Object.defineProperty(base, 'destroyed', { get: () => false })
  // The mock stands in for a `net.Socket`; the fields RtspSession reads are the ones above.
  const socket = base as unknown as Socket
  const mock: CorkCountingSocket = {
    socket,
    written,
    corks: () => corks,
    uncorks: () => uncorks,
    setBacklogged: (b) => {
      backlogged = b
    },
  }
  sockets.push(mock)
  return mock
}

const SDP =
  'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n' +
  'm=audio 0 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=control:trackID=1\r\n'

/** SETUP video (+ audio) and PLAY; the response writes are cleared. */
function playing(mock: CorkCountingSocket, withAudio = false): RtspSession {
  const session = new RtspSession(mock.socket, SDP, undefined, false)
  mock.socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  if (withAudio) {
    mock.socket.emit(
      'data',
      Buffer.from(
        'SETUP rtsp://localhost/test/trackID=1 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=2-3\r\n\r\n',
      ),
    )
  }
  mock.socket.emit('data', Buffer.from('PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 3\r\n\r\n'))
  mock.written.length = 0
  return session
}

function packet(marker: boolean): RtpPacket {
  const data = Buffer.alloc(20)
  data[0] = 0x80
  data[1] = (marker ? 0x80 : 0) | 96
  return { data, marker }
}

/** Let the session's nextTick safety net run. */
const tick = (): Promise<void> => new Promise((r) => process.nextTick(r))

describe('RtspSession corks once per access unit', () => {
  it('a five-packet access unit is one cork and one uncork, on the marker', () => {
    const mock = createCorkCountingSocket()
    const session = playing(mock)

    for (let i = 0; i < 4; i++)
      expect(session.sendRtp(packet(false), false, i === 0)).toBe('written')
    // Mid-picture: corked, not yet flushed.
    expect(mock.corks()).toBe(1)
    expect(mock.uncorks()).toBe(0)

    expect(session.sendRtp(packet(true), false, false)).toBe('written')
    expect(mock.corks()).toBe(1)
    expect(mock.uncorks()).toBe(1)
    // Every record reached the socket: 5 × (header, payload).
    expect(mock.written).toHaveLength(10)
  })

  it('two access units are two corks and two uncorks — never one per packet', () => {
    const mock = createCorkCountingSocket()
    const session = playing(mock)
    for (const marker of [false, false, true, false, true]) session.sendRtp(packet(marker))
    expect(mock.corks()).toBe(2)
    expect(mock.uncorks()).toBe(2)
  })

  it('a marker-less picture is uncorked by the next tick, never held across I/O', async () => {
    const mock = createCorkCountingSocket()
    const session = playing(mock)
    for (let i = 0; i < 3; i++) session.sendRtp(packet(false))
    expect(mock.corks()).toBe(1)
    expect(mock.uncorks()).toBe(0)
    await tick()
    expect(mock.uncorks()).toBe(1)
    // The next picture starts a cork of its own.
    session.sendRtp(packet(false))
    expect(mock.corks()).toBe(2)
    await tick()
    expect(mock.uncorks()).toBe(2)
  })

  it('an audio packet is its own access unit: it flushes what the video had corked', () => {
    const mock = createCorkCountingSocket()
    const session = playing(mock, true)
    session.sendRtp(packet(false))
    expect(session.sendAudioRtp(packet(true))).toBe('written')
    expect(mock.uncorks()).toBe(1)
    session.sendRtp(packet(true))
    expect(mock.corks()).toBe(2)
    expect(mock.uncorks()).toBe(2)
  })

  it('backpressure mid-picture still drops and latches, and the socket is not left corked', async () => {
    const mock = createCorkCountingSocket()
    const session = playing(mock)
    expect(session.sendRtp(packet(false), false, true)).toBe('written')
    mock.setBacklogged(true)
    expect(session.sendRtp(packet(false))).toBe('dropped-backlog')
    expect(session.sendRtp(packet(true))).toBe('dropped-latched')
    mock.setBacklogged(false)
    // Latched until the next keyframe AU start.
    expect(session.sendRtp(packet(false), false, false)).toBe('dropped-latched')
    expect(session.sendRtp(packet(true), false, true)).toBe('written')
    await tick()
    expect(mock.uncorks()).toBe(mock.corks())
  })
})
