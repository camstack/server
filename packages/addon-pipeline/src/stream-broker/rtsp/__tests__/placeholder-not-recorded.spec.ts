/**
 * A PLACEHOLDER picture is a courtesy to a sentry, never footage.
 *
 * The defect these specs close: the sentry/placeholder frame is emitted with
 * `isPlaceholder: true`, but `pushPacket` dropped the flag, so `handleNal`
 * wrote the courtesy picture to EVERY playing session — including the
 * recorder's `/recording` one, which then recorded minutes of a still image
 * as if the camera had been filming.
 */
import { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import type { EncodedPacket } from '@camstack/types'

import { RECORDING_PATH_SUFFIX, SENTRY_PATH_SUFFIX, parseRestreamPath } from '../restream-intent.js'
import { RtspRestreamer } from '../rtsp-restreamer.js'
import { RtspSession } from '../rtsp-session.js'

const TOKEN = 'c1609d0c9ec63e76852da48e3be1593e'
const SENTRY_DECL = parseRestreamPath(`${TOKEN}${SENTRY_PATH_SUFFIX}`).declaration
const RECORDING_DECL = parseRestreamPath(`${TOKEN}${RECORDING_PATH_SUFFIX}`).declaration
const SDP =
  'v=0\r\ns=cam\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

const START = Buffer.from([0, 0, 0, 1])
const SPS = Buffer.concat([START, Buffer.from([0x67, 0x42, 0x00, 0x1f, 0xe9, 0x40, 0x50, 0x1e])])
const PPS = Buffer.concat([START, Buffer.from([0x68, 0xce, 0x38, 0x80])])
const IDR = Buffer.concat([START, Buffer.from([0x65, 0x88, 0x84, 0x00, 0x10, 0x20, 0x30, 0x40])])

const sockets: Array<{ destroy: () => void }> = []
afterEach(() => {
  for (const s of sockets) s.destroy()
  sockets.length = 0
})

interface Mock {
  readonly socket: Socket
  readonly written: Buffer[]
}

function mockSocket(): Mock {
  const written: Buffer[] = []
  const socket = new Socket()
  socket.write = (chunk: Buffer | string): boolean => {
    written.push(Buffer.from(chunk))
    return true
  }
  sockets.push(socket)
  return { socket, written }
}

function play(restreamer: RtspRestreamer, mock: Mock, session: RtspSession): void {
  restreamer.addSession(session)
  mock.socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/t/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  mock.socket.emit('data', Buffer.from('PLAY rtsp://localhost/t RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
  mock.written.length = 0
}

function videoBytes(mock: Mock): number {
  return mock.written.reduce((n, w) => n + w.length, 0)
}

function packet(isPlaceholder: boolean): EncodedPacket {
  return {
    type: 'video',
    codec: 'h264',
    pts: 1000,
    keyframe: true,
    data: Buffer.concat([SPS, PPS, IDR, START]),
    ...(isPlaceholder ? { isPlaceholder: true } : {}),
  }
}

function setup(): { restreamer: RtspRestreamer; sentry: Mock; recorder: Mock } {
  const restreamer = new RtspRestreamer('106/native:main')
  restreamer.setCameraSdp(SDP, 'h264', null)
  const sentry = mockSocket()
  const recorder = mockSocket()
  play(restreamer, sentry, new RtspSession(sentry.socket, SDP, undefined, false, SENTRY_DECL))
  play(
    restreamer,
    recorder,
    new RtspSession(recorder.socket, SDP, undefined, false, RECORDING_DECL),
  )
  return { restreamer, sentry, recorder }
}

describe('placeholder frames are not footage', () => {
  it('control: a real frame reaches both the sentry and the recorder', () => {
    const { restreamer, sentry, recorder } = setup()
    restreamer.pushPacket(packet(false))
    restreamer.pushPacket(packet(false))
    expect(videoBytes(sentry)).toBeGreaterThan(0)
    expect(videoBytes(recorder)).toBeGreaterThan(0)
  })

  it('a placeholder frame reaches the sentry and NOT the recorder', () => {
    const { restreamer, sentry, recorder } = setup()
    restreamer.pushPacket(packet(true))
    restreamer.pushPacket(packet(true))
    expect(videoBytes(sentry)).toBeGreaterThan(0)
    expect(videoBytes(recorder)).toBe(0)
  })
})
