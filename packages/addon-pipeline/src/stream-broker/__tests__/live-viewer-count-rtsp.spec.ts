import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { RestreamDeclaration } from '../rtsp/restream-intent.js'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import { RtspSession } from '../rtsp/rtsp-session.js'

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

interface MockPeer {
  readonly socket: Socket
  readonly emitter: EventEmitter
}

function mockPeer(remoteAddress: string): MockPeer {
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    remoteAddress,
    remotePort: 40000,
    write: () => true,
    cork: () => undefined,
    uncork: () => undefined,
    destroy: vi.fn(),
    unshift: () => undefined,
    writableLength: 0,
    destroyed: false,
  }) as unknown as Socket
  return { socket, emitter }
}

interface DialOptions {
  readonly remoteAddress?: string
  readonly userAgent?: string
  readonly muted?: boolean
  readonly declaration?: RestreamDeclaration
  /** Stop before PLAY: a client that only DESCRIBEd. */
  readonly stopBeforePlay?: boolean
}

/** Connect a client the way the listen server does: the session removes itself on close. */
function dial(restreamer: RtspRestreamer, opts: DialOptions = {}): MockPeer {
  const peer = mockPeer(opts.remoteAddress ?? '192.168.1.40')
  const session = new RtspSession(
    peer.socket,
    SDP,
    () => restreamer.removeSession(session.getSessionId()),
    opts.muted ?? false,
    opts.declaration,
  )
  restreamer.addSession(session)
  const ua = opts.userAgent === undefined ? '' : `User-Agent: ${opts.userAgent}\r\n`
  peer.emitter.emit('data', Buffer.from(`OPTIONS rtsp://h/t RTSP/1.0\r\nCSeq: 1\r\n${ua}\r\n`))
  peer.emitter.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://h/t/trackID=0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  if (opts.stopBeforePlay !== true) {
    peer.emitter.emit('data', Buffer.from('PLAY rtsp://h/t RTSP/1.0\r\nCSeq: 3\r\n\r\n'))
  }
  return peer
}

function makeRestreamer(): RtspRestreamer {
  const restreamer = new RtspRestreamer('7/high')
  restreamer.setCameraSdp(SDP, 'h264', null)
  return restreamer
}

describe('RtspRestreamer.countExternalViewers', () => {
  it('counts a playing client from another host', () => {
    const r = makeRestreamer()
    dial(r, { userAgent: 'VLC/3.0.20 LibVLC/3.0.20' })
    expect(r.countExternalViewers()).toBe(1)
  })

  it('does not count the system: recorder, detection decode, agent pull, loopback ffmpeg, muted loopback', () => {
    const r = makeRestreamer()
    dial(r, { userAgent: 'recorder/7/high/1', remoteAddress: '127.0.0.1' })
    dial(r, {
      userAgent: 'decode/7/2',
      muted: true,
      declaration: { intent: 'detection', preRollRequestMs: 0 },
    })
    dial(r, { userAgent: 'camstack-rtsp-client', remoteAddress: '192.0.2.30' })
    dial(r, { userAgent: 'Lavf60.16.100', remoteAddress: '::ffff:127.0.0.1' })
    dial(r, { muted: true })
    dial(r, { declaration: { intent: 'sentry', preRollRequestMs: 0 } })
    expect(r.getSessionCount()).toBe(6)
    expect(r.countExternalViewers()).toBe(0)
  })

  it('counts only external clients when system and external are mixed', () => {
    const r = makeRestreamer()
    dial(r, { userAgent: 'recorder/7/high/1', remoteAddress: '127.0.0.1' })
    dial(r, { userAgent: 'external-nvr' })
    dial(r, { userAgent: 'VLC' })
    expect(r.countExternalViewers()).toBe(2)
  })

  it('does not count a client that never reached PLAY', () => {
    const r = makeRestreamer()
    dial(r, { stopBeforePlay: true })
    expect(r.countExternalViewers()).toBe(0)
  })

  it('decrements when a client disconnects (TEARDOWN)', () => {
    const r = makeRestreamer()
    const a = dial(r, { userAgent: 'VLC' })
    dial(r, { userAgent: 'VLC' })
    expect(r.countExternalViewers()).toBe(2)
    a.emitter.emit('data', Buffer.from('TEARDOWN rtsp://h/t RTSP/1.0\r\nCSeq: 4\r\n\r\n'))
    expect(r.countExternalViewers()).toBe(1)
  })

  it('decrements on an abrupt socket close with no TEARDOWN', () => {
    const r = makeRestreamer()
    const a = dial(r, { userAgent: 'VLC' })
    expect(r.countExternalViewers()).toBe(1)
    a.emitter.emit('close')
    expect(r.countExternalViewers()).toBe(0)
  })

  it('decrements on a socket error', () => {
    const r = makeRestreamer()
    const a = dial(r, { userAgent: 'VLC' })
    a.emitter.emit('error', new Error('ECONNRESET'))
    expect(r.countExternalViewers()).toBe(0)
  })

  it('stops counting a closed session even if the restreamer was never told to remove it', () => {
    const r = makeRestreamer()
    const peer = mockPeer('192.168.1.40')
    // No onClose wiring: the session stays in the map after the socket dies.
    const session = new RtspSession(peer.socket, SDP)
    r.addSession(session)
    peer.emitter.emit(
      'data',
      Buffer.from(
        'SETUP rtsp://h/t/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
      ),
    )
    peer.emitter.emit('data', Buffer.from('PLAY rtsp://h/t RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
    expect(r.countExternalViewers()).toBe(1)
    peer.emitter.emit('close')
    expect(r.getSessionCount()).toBe(1)
    expect(r.countExternalViewers()).toBe(0)
  })
})
