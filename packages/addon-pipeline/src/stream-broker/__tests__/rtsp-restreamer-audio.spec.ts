import { describe, it, expect, vi, afterEach } from 'vitest'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import { RtspSession } from '../rtsp/rtsp-session.js'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'

/**
 * Reassemble the interleaved RTP records a session wrote.
 *
 * `RtspSession.writeInterleaved` emits the 4-byte header and the SHARED payload
 * as two corked writes (one `writev`) instead of copying the payload into a
 * combined buffer — that copy ran once per packet per connected client and was
 * the broker's largest allocation source. The socket peer sees the same bytes
 * either way, so this helper rejoins the pair and every assertion below keeps
 * reading a whole `$ ch len payload` record.
 */
function interleavedRecords(written: readonly Buffer[]): readonly Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < written.length; i++) {
    const head = written[i]
    if (head === undefined || head.length !== 4 || head[0] !== 0x24) continue
    const payload = written[i + 1]
    if (payload === undefined) continue
    out.push(Buffer.concat([head, payload]))
    i++
  }
  return out
}

const activeSockets: Array<{ destroy: () => void }> = []

afterEach(() => {
  for (const s of activeSockets) s.destroy()
  activeSockets.length = 0
})

/** Create a minimal mock socket that captures writes without streams. */
function createMockSocket(): { socket: Socket; written: Buffer[] } {
  const written: Buffer[] = []
  const emitter = new EventEmitter()

  const socket = Object.assign(emitter, {
    write(chunk: Buffer | string): boolean {
      if (Buffer.isBuffer(chunk)) written.push(Buffer.from(chunk))
      else written.push(Buffer.from(chunk))
      return true
    },
    // `writeInterleaved` corks the header+payload pair into one `writev`.
    cork() {
      /* no-op: this mock records each chunk as the peer would see it */
    },
    uncork() {
      /* no-op */
    },
    destroy: vi.fn(),
    unshift(_chunk: Buffer) {
      /* no-op for mock */
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

describe('RtspRestreamer audio', () => {
  describe('stripAudioFromSdp (via setCameraSdp → getMutedSdp)', () => {
    it('should strip audio sections from SDP for muted sessions', () => {
      const restreamer = new RtspRestreamer('test-stream')

      const sdp = [
        'v=0',
        'o=- 1234 1 IN IP4 192.168.10.100',
        's=Camera',
        't=0 0',
        'a=control:rtsp://192.168.10.100/stream1',
        'm=video 0 RTP/AVP 96',
        'c=IN IP4 0.0.0.0',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 packetization-mode=1;profile-level-id=42001e',
        'a=control:trackID=0',
        'm=audio 0 RTP/AVP 0',
        'c=IN IP4 0.0.0.0',
        'a=rtpmap:0 PCMU/8000',
        'a=control:trackID=1',
      ].join('\r\n')

      restreamer.setCameraSdp(sdp, 'h264', null)

      // Full SDP should contain audio
      const fullSdp = restreamer.getSdp()
      expect(fullSdp).toContain('m=audio')
      expect(fullSdp).toContain('PCMU')

      // Muted SDP should NOT contain audio
      const mutedSdp = restreamer.getMutedSdp()
      expect(mutedSdp).not.toContain('m=audio')
      expect(mutedSdp).not.toContain('PCMU')

      // But should still contain video
      expect(mutedSdp).toContain('m=video')
      expect(mutedSdp).toContain('H264')
    })

    it('should handle SDP with no audio section', () => {
      const restreamer = new RtspRestreamer('test-stream')

      const sdp = [
        'v=0',
        'o=- 1234 1 IN IP4 0.0.0.0',
        's=Camera',
        'm=video 0 RTP/AVP 96',
        'a=rtpmap:96 H264/90000',
        'a=control:trackID=0',
      ].join('\r\n')

      restreamer.setCameraSdp(sdp, 'h264', null)

      const mutedSdp = restreamer.getMutedSdp()
      expect(mutedSdp).toContain('m=video')
      expect(mutedSdp).not.toContain('m=audio')
    })
  })

  describe('pushAudioRtpPassthrough', () => {
    it('should not forward audio RTP to muted sessions', () => {
      const restreamer = new RtspRestreamer('test-stream')
      const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'
      restreamer.setCameraSdp(sdp, 'h264', null)

      // Create a muted session
      const { socket: mutedSocket, written: mutedWritten } = createMockSocket()
      const mutedSession = new RtspSession(mutedSocket, restreamer.getMutedSdp()!, undefined, true)

      restreamer.addSession(mutedSession)

      // Simulate SETUP + PLAY to make session active
      mutedSocket.emit(
        'data',
        Buffer.from(
          `SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`,
        ),
      )
      mutedSocket.emit(
        'data',
        Buffer.from(`PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 2\r\n\r\n`),
      )

      // Clear writes from SETUP/PLAY responses
      mutedWritten.length = 0

      // Push video — muted session SHOULD get video
      const videoRtp = Buffer.alloc(20)
      videoRtp[0] = 0x80
      videoRtp[1] = 0x60 // PT=96, marker=0

      // First we need to send a keyframe to clear pendingKeyframe
      restreamer.pushRtpPassthrough(videoRtp, true, false)
      mutedWritten.length = 0

      // Push audio RTP — muted session should NOT get it
      const audioRtp = Buffer.alloc(20)
      audioRtp[0] = 0x80
      audioRtp[1] = 0x00 // PT=0 (PCMU), marker=0

      restreamer.pushAudioRtpPassthrough(audioRtp)

      // Check that muted session received no audio
      // Audio frames use channel from tracks[1], but muted session should be skipped entirely
      const audioFrames = interleavedRecords(mutedWritten)
      expect(audioFrames.length).toBe(0)
    })
  })

  describe('resetStreamState', () => {
    it('should clear all audio/video state', () => {
      const restreamer = new RtspRestreamer('test-stream')
      const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\nm=audio 0 RTP/AVP 0\r\n'
      restreamer.setCameraSdp(sdp, 'h264', null)

      expect(restreamer.rtpPassthroughMode).toBe(true)
      expect(restreamer.getSdp()).toBeTruthy()

      restreamer.resetStreamState()

      expect(restreamer.rtpPassthroughMode).toBe(false)
      expect(restreamer.getSdp()).toBeNull()
      expect(restreamer.getMutedSdp()).toBeNull()
    })
  })
})
