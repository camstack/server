import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { vi } from 'vitest'
import type { RtspRestreamer } from '../../rtsp/rtsp-restreamer.js'
import { RtspSession } from '../../rtsp/rtsp-session.js'
import { MAX_WRITE_BUFFER } from '../../rtsp/rtsp-types.js'

/**
 * A playing RTSP session on a socket whose kernel backlog the spec controls —
 * the seam for every "a backlogged client" assertion against the restreamer.
 * Call {@link destroyMockSockets} from `afterEach`.
 */
export interface MockSocket {
  readonly socket: Socket
  readonly written: Buffer[]
  readonly destroy: ReturnType<typeof vi.fn>
  setBacklogged: (backlogged: boolean) => void
}

const activeSockets: MockSocket[] = []

export function destroyMockSockets(): void {
  for (const s of activeSockets) s.socket.destroy()
  activeSockets.length = 0
}

export function createMockSocket(): MockSocket {
  const written: Buffer[] = []
  const emitter = new EventEmitter()
  let backlogged = false
  const destroy = vi.fn()

  const base = Object.assign(emitter, {
    write(chunk: Buffer | string): boolean {
      written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk))
      return true
    },
    cork() {
      /* no-op: the mock records each chunk as the peer would see it */
    },
    uncork() {
      /* no-op */
    },
    destroy,
    unshift(_chunk: Buffer) {
      /* no-op for mock */
    },
    remoteAddress: '127.0.0.1',
    remotePort: 55555,
  })
  // Defined, not spread: `Object.assign` would freeze a getter's current value.
  Object.defineProperty(base, 'writableLength', {
    get: () => (backlogged ? MAX_WRITE_BUFFER + 1 : 0),
  })
  Object.defineProperty(base, 'destroyed', { get: () => false })
  // The mock stands in for a `net.Socket`; the fields RtspSession reads are the ones above.
  const socket = base as unknown as Socket
  const mock: MockSocket = {
    socket,
    written,
    destroy,
    setBacklogged: (b) => {
      backlogged = b
    },
  }
  activeSockets.push(mock)
  return mock
}

export const H265_SDP =
  'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H265/90000\r\na=control:trackID=0\r\n'

/** Add a non-muted session, drive it through SETUP + PLAY, and clear the response writes. */
export function playSession(restreamer: RtspRestreamer, mock: MockSocket): RtspSession {
  const session = new RtspSession(mock.socket, H265_SDP, undefined, false)
  restreamer.addSession(session)
  mock.socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  mock.socket.emit('data', Buffer.from('PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
  mock.written.length = 0
  return session
}

/** Interleaved RTP data frames ($-magic headers) written to a session's socket. */
export function countRtpFrames(written: readonly Buffer[]): number {
  return written.filter((b) => b.length === 4 && b[0] === 0x24).length
}
