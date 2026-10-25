import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { RtspSession } from '../rtsp/rtsp-session.js'
import { MAX_WRITE_BUFFER, MAX_MISSED_KEYFRAMES, type RtpPacket } from '../rtsp/rtsp-types.js'

/**
 * Backpressure decides LIVENESS, not identity.
 *
 * Measured on the live hub 2026-09-01: 899 `SegmentWriter ffmpeg exited` in
 * 24 h, 898 of them `exitCode=0` with no signal — ffmpeg was not crashing, its
 * INPUT was ending. The input is the broker's own RTSP restream, and two
 * seconds before every one of those deaths the broker logged
 * `restream dropped packets … clientsClosedOnBacklog=1` (949 of 1 228 backlog
 * lines in the window). The broker was closing the recorder's own pull; ffmpeg
 * saw EOF, exited 0, the recorder respawned, and the respawn was served a
 * pre-roll (1 070 in the window) that REPLAYED footage already on disk — the
 * duplicate-at-respawn nobody could explain.
 *
 * The old rule asked WHO the session was: `muted` (the local decoder loopback)
 * was spared, everyone else was closed on the first backlog hit. That is the
 * wrong question. A recorder 2 MiB behind for forty milliseconds is coming
 * back; a phone that left the wifi is not. Both were classified by identity.
 *
 * The rule these tests pin asks whether the session is STILL THERE:
 *   • nobody is closed for being momentarily behind — every session drops the
 *     packet and latches to the next keyframe AU;
 *   • a session is closed only after `MAX_MISSED_KEYFRAMES` CONSECUTIVE
 *     keyframes at which it still could not be written;
 *   • `muted` is not special — it simply never reaches the bound, because the
 *     loopback drains.
 *
 * Closing still has to exist: there is no read-side timeout on a session, and
 * `sessions.size` gates real upstream work, so a peer that vanished without a
 * FIN would otherwise hold a stream open for hours.
 */

interface Harness {
  readonly session: RtspSession
  readonly destroy: ReturnType<typeof vi.fn>
  /** Drive the socket's reported kernel backlog. */
  setBacklogged: (backlogged: boolean) => void
}

function createHarness(muted: boolean): Harness {
  const emitter = new EventEmitter()
  const destroy = vi.fn()
  let backlogged = false

  const base = Object.assign(emitter, {
    write: () => true,
    cork: () => undefined,
    uncork: () => undefined,
    destroy,
    unshift: () => undefined,
    remoteAddress: '127.0.0.1',
    remotePort: 55555,
  })
  // DEFINED, not spread: `Object.assign` would copy the getter's current value
  // and freeze the backlog at 0, making every assertion here vacuously pass.
  Object.defineProperty(base, 'writableLength', {
    get: () => (backlogged ? MAX_WRITE_BUFFER + 1 : 0),
  })
  Object.defineProperty(base, 'destroyed', { get: () => false })
  const socket = base as unknown as Socket

  const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n'
  const session = new RtspSession(socket, sdp, undefined, muted)
  socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  socket.emit('data', Buffer.from('PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 2\r\n\r\n'))

  return {
    session,
    destroy,
    setBacklogged: (v) => {
      backlogged = v
    },
  }
}

function packet(): RtpPacket {
  const data = Buffer.alloc(20)
  data[0] = 0x80
  data[1] = 0x60
  return { data, marker: false }
}

/** Send one packet that begins a keyframe access unit. */
function sendKeyframe(session: RtspSession): string {
  return session.sendRtp(packet(), false, true)
}

/** Send one ordinary (non-keyframe) packet. */
function sendLive(session: RtspSession): string {
  return session.sendRtp(packet(), false, false)
}

describe('RTSP backpressure closes on absence, never on identity', () => {
  it('does not close a non-muted session that is momentarily behind', () => {
    const h = createHarness(false)
    h.setBacklogged(true)

    // The recorder's exact shape: backlogged mid-GOP, not at a keyframe.
    expect(sendLive(h.session)).toBe('dropped-backlog')
    expect(h.destroy).not.toHaveBeenCalled()
  })

  it('treats a muted session and an external one identically while behind', () => {
    const external = createHarness(false)
    const loopback = createHarness(true)
    external.setBacklogged(true)
    loopback.setBacklogged(true)

    expect(sendLive(external.session)).toBe(sendLive(loopback.session))
    expect(external.destroy).not.toHaveBeenCalled()
    expect(loopback.destroy).not.toHaveBeenCalled()
  })

  it('recovers on the next keyframe once the socket drains, and never closes', () => {
    const h = createHarness(false)
    h.setBacklogged(true)
    expect(sendLive(h.session)).toBe('dropped-backlog')

    // Latched: a mid-GOP packet is refused even after the socket drains, so the
    // decoder never resumes mid-GOP.
    h.setBacklogged(false)
    expect(sendLive(h.session)).toBe('dropped-latched')

    // The keyframe AU is the clean resume point.
    expect(sendKeyframe(h.session)).toBe('written')
    expect(h.destroy).not.toHaveBeenCalled()
  })

  it('closes a session that misses MAX_MISSED_KEYFRAMES consecutive keyframes', () => {
    const h = createHarness(false)
    h.setBacklogged(true)

    let last = ''
    for (let i = 0; i < MAX_MISSED_KEYFRAMES; i++) {
      // Each keyframe clears the latch, hits the still-full socket, and counts.
      last = sendKeyframe(h.session)
    }

    expect(last).toBe('closed-backlog')
    expect(h.destroy).toHaveBeenCalled()
  })

  it('does not close on the keyframe BEFORE the bound', () => {
    const h = createHarness(false)
    h.setBacklogged(true)

    for (let i = 0; i < MAX_MISSED_KEYFRAMES - 1; i++) {
      expect(sendKeyframe(h.session)).toBe('dropped-backlog')
    }
    expect(h.destroy).not.toHaveBeenCalled()
  })

  it('resets the missed-keyframe count after a keyframe that DOES get written', () => {
    const h = createHarness(false)
    h.setBacklogged(true)
    for (let i = 0; i < MAX_MISSED_KEYFRAMES - 1; i++) sendKeyframe(h.session)

    // One good keyframe: the session proved it is still there.
    h.setBacklogged(false)
    expect(sendKeyframe(h.session)).toBe('written')

    // The budget must start over — otherwise a session that recovers once every
    // GOP still dies, which is exactly the recorder's pattern.
    h.setBacklogged(true)
    for (let i = 0; i < MAX_MISSED_KEYFRAMES - 1; i++) {
      expect(sendKeyframe(h.session)).toBe('dropped-backlog')
    }
    expect(h.destroy).not.toHaveBeenCalled()
  })

  it('never closes on an audio packet — video liveness owns the decision', () => {
    const h = createHarness(false)
    h.setBacklogged(true)

    // Audio has no keyframes, so it cannot measure absence; it may only drop.
    expect(h.session.sendAudioRtp(packet())).not.toBe('closed-backlog')
    expect(h.destroy).not.toHaveBeenCalled()
  })
})
