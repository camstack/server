/**
 * The replay SESSION, against a real TCP socket playing back a real capture.
 *
 * The server is a `node:net` listener that speaks the RTSP the camera speaks —
 * the digest challenge, the verbatim `DESCRIBE` body of a real session, a
 * `SETUP` per track, a `PLAY` — and then writes the captured interleaved bytes
 * and goes QUIET WITHOUT CLOSING, which is exactly what the camera does at the
 * end of a segment and what the first version of this module filed as a
 * failure.
 *
 * A fake that resolved a promise would have proved nothing about that: the
 * defect is a timer rule over a socket, and it survived fourteen green unit
 * tests until a live clip hit it.
 */

import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoAccessUnit } from '../rtsp/rtp-depacketize.js'
import { openRtspReplay, type RtspReplayEnd } from '../rtsp/rtsp-replay-session.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const sdpBody = readFileSync(join(FIXTURES, 'replay-3833.sdp'), 'utf8')
const media = readFileSync(join(FIXTURES, 'replay-3833-interleaved.bin'))

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
  withTags: () => logger,
}

interface FakeCamera {
  readonly port: number
  /** Status to answer SETUP with. 200 unless a test says otherwise. */
  setupStatus: number
  /** Deliver the captured media and then go quiet WITHOUT closing. */
  readonly deliver: () => void
  readonly close: () => Promise<void>
  /** Verbs the camera saw, in order. */
  readonly verbs: string[]
}

function startCamera(
  options: { setupStatus?: number; deliverOnPlay?: boolean } = {},
): Promise<FakeCamera> {
  const verbs: string[] = []
  let live: Socket | null = null
  let server: Server | null = null
  const state = { setupStatus: options.setupStatus ?? 200 }
  const deliver = (): void => {
    live?.write(media)
  }
  return new Promise((resolve) => {
    server = createServer((socket) => {
      live = socket
      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1')
        for (;;) {
          const end = buffer.indexOf('\r\n\r\n')
          if (end === -1) return
          const head = buffer.slice(0, end)
          buffer = buffer.slice(end + 4)
          const [verb = ''] = head.split(' ')
          verbs.push(verb)
          const cseq = /CSeq: (\d+)/.exec(head)?.[1] ?? '1'
          const authorized = head.includes('Authorization: Digest')
          if (!authorized) {
            socket.write(
              `RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\n` +
                'WWW-Authenticate: Digest realm="camera", nonce="abc", qop="auth"\r\n\r\n',
            )
            continue
          }
          if (verb === 'DESCRIBE') {
            socket.write(
              `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nContent-Type: application/sdp\r\n` +
                `Content-Length: ${String(Buffer.byteLength(sdpBody))}\r\n\r\n${sdpBody}`,
            )
            continue
          }
          if (verb === 'SETUP') {
            socket.write(
              `RTSP/1.0 ${String(state.setupStatus)} ${state.setupStatus === 200 ? 'OK' : 'Internal Server Error'}\r\n` +
                `CSeq: ${cseq}\r\nSession: 1234;timeout=60\r\n\r\n`,
            )
            continue
          }
          if (verb === 'PLAY') {
            socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: 1234\r\n\r\n`)
            if (options.deliverOnPlay !== false) setTimeout(deliver, 5)
            continue
          }
          socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`)
        }
      })
      socket.on('error', () => {})
    })
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server?.address() ?? null
      const port = address !== null && typeof address !== 'string' ? address.port : 0
      resolve({
        port,
        get setupStatus() {
          return state.setupStatus
        },
        set setupStatus(value: number) {
          state.setupStatus = value
        },
        deliver,
        verbs,
        close: () =>
          new Promise<void>((done) => {
            live?.destroy()
            server?.close(() => done())
          }),
      })
    })
  })
}

let camera: FakeCamera | null = null
afterEach(async () => {
  await camera?.close()
  camera = null
})

async function play(options: {
  quietMs?: number
  idleMs?: number
  setupStatus?: number
  deliverOnPlay?: boolean
}): Promise<{ end: RtspReplayEnd; units: VideoAccessUnit[]; audio: number; host: string }> {
  const started = await startCamera({
    ...(options.setupStatus === undefined ? {} : { setupStatus: options.setupStatus }),
    ...(options.deliverOnPlay === undefined ? {} : { deliverOnPlay: options.deliverOnPlay }),
  })
  camera = started
  const units: VideoAccessUnit[] = []
  let audio = 0
  const session = await openRtspReplay(
    {
      host: '127.0.0.1',
      port: started.port,
      username: 'u',
      password: 'p',
      playbackPath: '/Streaming/tracks/101/?starttime=x&endtime=y',
    },
    {
      onVideo: (unit) => units.push(unit),
      onAudio: () => {
        audio += 1
      },
    },
    {
      logger,
      deviceId: 3833,
      segmentQuietMs: options.quietMs ?? 150,
      idleTimeoutMs: options.idleMs ?? 2_000,
    },
  )
  return { end: await session.ended, units, audio, host: '127.0.0.1' }
}

describe('the replay session', () => {
  it('calls a quiet socket AFTER media the end of the segment, not a failure', async () => {
    // Measured on 3833: a 19 s segment delivered 246 access units in 18.9 s
    // and then went quiet with the socket OPEN until the camera's own 60 s
    // timeout. A single idle rule filed every complete clip as `idle`.
    const { end, units, audio } = await play({ quietMs: 150, idleMs: 5_000 })
    expect(end.kind).toBe('complete')
    if (end.kind !== 'complete') return
    expect(units).toHaveLength(6)
    expect(audio).toBe(13)
    // The span is taken over every video PACKET that arrived, from the media's
    // own 90 kHz clock and never from the catalog row: the fixture's last
    // packets belong to a seventh frame the slice cuts in half, and 480 ms is
    // what really came off the wire. Six whole units span 400 ms.
    expect(end.deliveredMs).toBe(480)
  }, 20_000)

  it('calls a quiet socket BEFORE any media a failure, by name', async () => {
    const { end, units } = await play({ deliverOnPlay: false, idleMs: 200, quietMs: 5_000 })
    expect(units).toEqual([])
    expect(end.kind).toBe('failed')
    if (end.kind !== 'failed') return
    expect(end.code).toBe('idle')
  }, 20_000)

  it('refuses a SETUP the camera declined, with its status, and opens nothing', async () => {
    // 500 is the camera's one playback slot being held by somebody else — it
    // says nothing about whether the clip exists, and it is never retried.
    await expect(play({ setupStatus: 500 })).rejects.toThrow(
      /SETUP of the video track answered 500/,
    )
  }, 20_000)

  it('tears the session down on the ORDINARY end of a segment, and the camera sees it', async () => {
    // The camera serves ONE playback session and frees it on TEARDOWN or on
    // its own 60 s timeout. The ordinary end of a Hikvision segment is a QUIET
    // socket, so the complete path is exactly the one that used to walk away
    // holding the slot — and the next clip the operator tapped met `SETUP …
    // 500`. A real socket, because `socket.destroy()` discarding a queued
    // `write()` is the defect and no fake reproduces it.
    const { end } = await play({ quietMs: 150, idleMs: 5_000 })
    expect(end.kind).toBe('complete')
    await vi.waitFor(() => {
      expect(camera?.verbs).toContain('TEARDOWN')
    })
  }, 20_000)

  it('walks OPTIONS-free, absorbs the digest challenge and sets up both tracks', async () => {
    await play({ quietMs: 150 })
    expect(camera?.verbs.filter((verb) => verb === 'DESCRIBE')).toHaveLength(2)
    expect(camera?.verbs.filter((verb) => verb === 'SETUP')).toHaveLength(2)
    expect(camera?.verbs).toContain('PLAY')
  }, 20_000)
})
