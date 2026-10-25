/**
 * D83 — the BROKER-SIDE audio mute, on both planes.
 *
 * The two planes leave the broker by completely different routes and a test
 * that only covered one would have been green while half the feature did
 * nothing:
 *
 * - **live** rides `onEncodedData` (WebRTC), so it is asserted on the
 *   encoded-packet fan-out;
 * - **recording** rides the RTSP restreamer the recorder's ffmpeg pulls, so it
 *   is asserted on the SDP that pull is answered with, not on a packet.
 *
 * Muting only the packets would leave the recorder's `-map 0` declaring an
 * audio stream that never delivers, which is worse than not muting at all.
 */
import type { EncodedPacket, IScopedLogger, StreamSource } from '@camstack/types'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import { RtspSession } from '../rtsp/rtsp-session.js'
import { StreamBroker } from '../stream-broker/stream-broker'

const CAMERA_SDP = [
  'v=0',
  'o=- 1234 1 IN IP4 192.168.10.100',
  's=Camera',
  't=0 0',
  'm=video 0 RTP/AVP 96',
  'a=rtpmap:96 H264/90000',
  'a=control:trackID=0',
  'm=audio 0 RTP/AVP 0',
  'a=rtpmap:0 PCMU/8000',
  'a=control:trackID=1',
].join('\r\n')

const activeSockets: Array<{ destroy: () => void }> = []

afterEach(() => {
  for (const s of activeSockets) s.destroy()
  activeSockets.length = 0
})

function createMockSocket(): Socket {
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    write: (): boolean => true,
    // `writeInterleaved` corks the header+payload pair into one `writev`.
    cork() {
      /* no-op: this mock records each chunk as the peer would see it */
    },
    uncork() {
      /* no-op */
    },
    destroy: vi.fn(),
    unshift: () => {
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
  return socket
}

function createMockLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  return logger
}

function pushSource(): StreamSource {
  return { type: 'push', url: '', videoCodec: 'h264', audioCodec: 'pcmu' }
}

function audioPacket(): EncodedPacket {
  return {
    type: 'audio',
    data: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    pts: 0,
    dts: 0,
    keyframe: false,
    codec: 'pcmu',
  }
}

function videoPacket(): EncodedPacket {
  return {
    type: 'video',
    data: Buffer.from('frame'),
    pts: 0,
    dts: 0,
    keyframe: true,
    codec: 'h264',
  }
}

describe('StreamBroker.setAudioMuted — the LIVE plane', () => {
  it('stops delivering audio to encoded subscribers while leaving video alone', async () => {
    const broker = new StreamBroker('7/native:main', createMockLogger())
    await broker.start(pushSource())
    const received: EncodedPacket[] = []
    broker.onEncodedData((p) => received.push(p))

    broker.pushEncodedPacket(videoPacket())
    broker.pushEncodedPacket(audioPacket())
    expect(received.map((p) => p.type)).toEqual(['video', 'audio'])

    broker.setAudioMuted(true)
    received.length = 0
    broker.pushEncodedPacket(videoPacket())
    broker.pushEncodedPacket(audioPacket())

    // The whole point: the picture is untouched.
    expect(received.map((p) => p.type)).toEqual(['video'])
    await broker.stop()
  })

  it('resumes on un-mute — the mute is a gate, not a teardown', async () => {
    const broker = new StreamBroker('7/native:main', createMockLogger())
    await broker.start(pushSource())
    const received: EncodedPacket[] = []
    broker.onEncodedData((p) => received.push(p))

    broker.setAudioMuted(true)
    broker.pushEncodedPacket(audioPacket())
    expect(received).toHaveLength(0)

    broker.setAudioMuted(false)
    broker.pushEncodedPacket(audioPacket())
    expect(received.map((p) => p.type)).toEqual(['audio'])
    await broker.stop()
  })

  it('reports the mute and the drop count in stats — muted must not read as broken', async () => {
    const broker = new StreamBroker('7/native:main', createMockLogger())
    await broker.start(pushSource())
    expect(broker.getStats().audioMuted).toBe(false)

    broker.setAudioMuted(true)
    broker.pushEncodedPacket(audioPacket())
    broker.pushEncodedPacket(audioPacket())

    expect(broker.isAudioMuted()).toBe(true)
    expect(broker.getStats().audioMuted).toBe(true)
    expect(broker.getStats().audioMutedDropped).toBe(2)
    await broker.stop()
  })

  it('announces the drop ONCE, not once per packet', async () => {
    const logger = createMockLogger()
    const broker = new StreamBroker('7/native:main', logger)
    await broker.start(pushSource())
    broker.setAudioMuted(true)
    for (let i = 0; i < 200; i++) broker.pushEncodedPacket(audioPacket())

    const dropLines = vi
      .mocked(logger.info)
      .mock.calls.filter(([message]) => String(message).includes('dropping this camera'))
    expect(dropLines).toHaveLength(1)
    // …and it names the device, because every miss is asked per-camera.
    expect(dropLines[0]?.[1]).toMatchObject({ tags: { deviceId: 7 } })
    await broker.stop()
  })

  it('is idempotent — setting the value it already holds does nothing', async () => {
    const logger = createMockLogger()
    const broker = new StreamBroker('7/native:main', logger)
    await broker.start(pushSource())
    broker.setAudioMuted(false)
    broker.setAudioMuted(false)
    const transitions = vi
      .mocked(logger.info)
      .mock.calls.filter(([message]) => String(message).includes('audio plane'))
    expect(transitions).toHaveLength(0)
    await broker.stop()
  })
})

describe('RtspRestreamer.setAudioMuted — the RECORDING plane', () => {
  it('serves the video-only SDP to EVERY puller, not just the ones asking for /muted', () => {
    const restreamer = new RtspRestreamer('7/native:main')
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)
    expect(restreamer.getSdp()).toContain('m=audio')

    restreamer.setAudioMuted(true)

    // This is the assertion that makes the RECORDING silent: the recorder's
    // ffmpeg maps whatever the SDP declared at connect time, so an `m=audio`
    // left in place would have it waiting on a stream we have decided never to
    // send.
    expect(restreamer.getSdp()).not.toContain('m=audio')
    expect(restreamer.getSdp()).not.toContain('PCMU')
    expect(restreamer.getSdp()).toContain('m=video')
    expect(restreamer.isDeviceAudioMuted()).toBe(true)
  })

  it('restores the audio track on un-mute', () => {
    const restreamer = new RtspRestreamer('7/native:main')
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)
    restreamer.setAudioMuted(true)
    restreamer.setAudioMuted(false)
    expect(restreamer.getSdp()).toContain('m=audio')
  })

  it('closes the audio-bearing pulls so they re-DESCRIBE, and leaves /muted pulls alone', () => {
    const restreamer = new RtspRestreamer('7/native:main')
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)

    const audioBearing = new RtspSession(createMockSocket(), restreamer.getSdp()!, undefined, false)
    const alreadyMuted = new RtspSession(
      createMockSocket(),
      restreamer.getMutedSdp()!,
      undefined,
      true,
    )
    restreamer.addSession(audioBearing)
    restreamer.addSession(alreadyMuted)
    expect(restreamer.getSessionCount()).toBe(2)

    const closed = restreamer.setAudioMuted(true)

    // Only the puller whose SDP declared audio is disturbed. Killing a local
    // decoder's feed to change nothing it receives would be a decode gap for
    // free.
    expect(closed).toBe(1)
    expect(restreamer.getSessionCount()).toBe(1)
  })

  it('is idempotent — the same value twice closes nobody', () => {
    const restreamer = new RtspRestreamer('7/native:main')
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)
    restreamer.addSession(new RtspSession(createMockSocket(), CAMERA_SDP, undefined, false))

    expect(restreamer.setAudioMuted(true)).toBe(1)
    expect(restreamer.setAudioMuted(true)).toBe(0)
    expect(restreamer.getSessionCount()).toBe(0)
  })

  it('drops audio RTP outright while muted', () => {
    const restreamer = new RtspRestreamer('7/native:main')
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)
    const session = new RtspSession(createMockSocket(), CAMERA_SDP, undefined, false)
    const sendAudio = vi.spyOn(session, 'sendAudioRtp')
    restreamer.addSession(session)

    const rtp = Buffer.alloc(20)
    rtp[0] = 0x80
    restreamer.setAudioMuted(true)
    restreamer.pushAudioRtpPassthrough(rtp)
    expect(sendAudio).not.toHaveBeenCalled()
  })

  it('survives a suspend/resume — an operator mute is not connection state', () => {
    const restreamer = new RtspRestreamer('7/native:main')
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)
    restreamer.setAudioMuted(true)

    // `resetStreamState` runs on every broker suspend. A camera going idle
    // overnight must not wake up distributing audio again.
    restreamer.resetStreamState()
    expect(restreamer.isDeviceAudioMuted()).toBe(true)

    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)
    expect(restreamer.getSdp()).not.toContain('m=audio')
  })
})

describe('StreamBroker.setAudioMuted — the two planes move together', () => {
  it('mutes the restreamer as part of muting the broker', async () => {
    const broker = new StreamBroker('7/native:main', createMockLogger())
    await broker.start(pushSource())
    const restreamer = broker.getRtspRestreamer()
    restreamer.setCameraSdp(CAMERA_SDP, 'h264', null)

    broker.setAudioMuted(true)
    expect(restreamer.isDeviceAudioMuted()).toBe(true)
    expect(restreamer.getSdp()).not.toContain('m=audio')

    broker.setAudioMuted(false)
    expect(restreamer.isDeviceAudioMuted()).toBe(false)
    expect(restreamer.getSdp()).toContain('m=audio')
    await broker.stop()
  })
})
