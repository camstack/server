/**
 * Recovering a LIVE session across a broker re-dial.
 *
 * The failure this pins, measured on Hikvision 104 (2026-08-07): toggling the
 * camera's microphone restarts its encoder, the RTSP connection drops, the
 * broker reconnects on its own — and the viewer freezes on the last frame
 * until pause+play. The broker was never the problem: it keeps the same object
 * across a reconnect, so the session's subscription survives and packets DO
 * resume. What broke was the MAPPING — a new RTSP session carries a fresh
 * random sequence/timestamp base, while werift's sender offset was latched
 * once, on the first packet of the connection that just died.
 *
 * Two altitudes here:
 *  1. the broker ANNOUNCES a restart, and only from the second dial onward;
 *  2. the session RE-LATCHES rather than carrying the dead connection's state.
 */
import { describe, expect, it, vi } from 'vitest'
import { AdaptiveSession } from '../session.js'

/**
 * White-box harness for restart latches — names must NOT intersect
 * `AdaptiveSession`'s private fields (TS reduces that intersection to `never`).
 */
interface AdaptiveSessionRestartHarness {
  sessionId: string
  deviceId: number
  closed: boolean
  logger: {
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    debug: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  rtpRebasePending: boolean
  rtpBootstrapDone: boolean
  sourceMediaSeen: boolean
  videoRtpSynced: boolean
  sourceVideoSsrc: number | null
  h264Repacketizer: unknown
  h265Repacketizer: unknown
  activeRtpReplay: unknown
  sourceSilenceTimer: unknown
  onSourceRestarted(reason: string): void
  switchLiveSource(args: {
    rtpBootstrap: () => readonly Buffer[]
    parameterSets: readonly Buffer[] | null
    reason: string
  }): void
}

/**
 * `AdaptiveSession`'s constructor needs werift; these are private latches with
 * no public reader. Rather than stand up a peer connection, build the object
 * without running the constructor and drive the one method under test — the
 * method touches nothing else.
 */
function bareSession(): AdaptiveSessionRestartHarness {
  const session = Object.create(AdaptiveSession.prototype) as AdaptiveSessionRestartHarness
  Object.assign(session, {
    sessionId: 'sess-1',
    deviceId: 104,
    closed: false,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    // The dead connection's state: latched, bootstrapped, packets seen.
    rtpRebasePending: false,
    rtpBootstrapDone: true,
    sourceMediaSeen: true,
    videoRtpSynced: true,
    sourceVideoSsrc: 0x1234abcd,
    h264Repacketizer: { seeded: true },
    h265Repacketizer: null,
    activeRtpReplay: null,
    sourceSilenceTimer: null,
  })
  return session
}

describe('AdaptiveSession.onSourceRestarted', () => {
  it('arms the REBASE, not the first-packet sync', () => {
    const session = bareSession()
    session.onSourceRestarted('dial#2')
    // `rtpRebasePending` continues the outbound stream from the last packet
    // actually sent. `videoRtpSynced`'s branch latches onto the SOURCE's raw
    // sequence — correct for the first packet ever, a visible jump here.
    expect(session.rtpRebasePending).toBe(true)
    expect((session as unknown as { videoRtpSynced: boolean }).videoRtpSynced).toBe(true)
  })

  it('replays the pre-buffer instead of waiting for the next natural IDR', () => {
    const session = bareSession()
    session.onSourceRestarted('dial#2')
    // Leaving this `true` is a keyframe interval of frozen picture coming out
    // of what is supposed to be a recovery.
    expect(session.rtpBootstrapDone).toBe(false)
  })

  it('drops the previous stream’s repacketizer and SSRC', () => {
    const session = bareSession()
    session.onSourceRestarted('dial#2')
    expect(session.h264Repacketizer).toBeNull()
    expect(session.sourceVideoSsrc).toBeNull()
  })

  it('re-arms the answered-but-silent guard against the NEW connection', () => {
    const session = bareSession()
    session.onSourceRestarted('dial#2')
    // A re-dial that never delivers is the same failure as a cold dial that
    // never delivers. Until this, only the cold one was ever named.
    expect(session.sourceMediaSeen).toBe(false)
    expect(
      (session as unknown as { sourceSilenceTimer: unknown }).sourceSilenceTimer,
    ).not.toBeNull()
  })

  it('does nothing once the session is closed', () => {
    const session = bareSession()
    Object.assign(session, { closed: true })
    session.onSourceRestarted('dial#2')
    expect(session.rtpRebasePending).toBe(false)
  })
})

/**
 * D733: an adaptive tier change moves the track onto ANOTHER broker in place.
 * Everything a re-dial needs, plus the new broker's bootstrap and SDP seed.
 */
describe('AdaptiveSession.switchLiveSource', () => {
  const sps = Buffer.from([0x67, 0x64, 0x00, 0x33])
  const pps = Buffer.from([0x68, 0xee, 0x3c, 0x80])

  function switchable(): AdaptiveSessionRestartHarness {
    const session = bareSession()
    Object.assign(session, {
      sourceCodec: 'H264',
      debug: false,
      repacketizerMtu: AdaptiveSession.ADAPTIVE_LOW_MTU,
      rtpBootstrap: () => [Buffer.from('old-gop')],
    })
    return session
  }

  it('replays the NEW broker from its keyframe on a rebased stream', () => {
    const session = switchable()
    const newGop = [Buffer.from('new-idr')]
    session.switchLiveSource({
      rtpBootstrap: () => newGop,
      parameterSets: null,
      reason: 'tier high',
    })
    expect(session.rtpRebasePending).toBe(true)
    expect(session.rtpBootstrapDone).toBe(false)
    expect(session.sourceVideoSsrc).toBeNull()
    const bootstrap = (session as unknown as { rtpBootstrap: () => readonly Buffer[] }).rtpBootstrap
    expect(bootstrap()).toBe(newGop)
  })

  it('re-seeds the repacketizer with the new rendition parameter sets', () => {
    const session = switchable()
    session.switchLiveSource({
      rtpBootstrap: () => [],
      parameterSets: [sps, pps],
      reason: 'tier high',
    })
    const rep = (
      session as unknown as { h264Repacketizer: { codecInfo?: { sps?: Buffer; pps?: Buffer } } }
    ).h264Repacketizer
    expect(rep.codecInfo?.sps?.equals(sps)).toBe(true)
    expect(rep.codecInfo?.pps?.equals(pps)).toBe(true)
  })

  it('returns the MTU to the default a fresh session has', () => {
    const session = switchable()
    session.switchLiveSource({ rtpBootstrap: () => [], parameterSets: null, reason: 'tier mid' })
    expect((session as unknown as { repacketizerMtu: number }).repacketizerMtu).toBe(
      AdaptiveSession.H264_REPACKETIZER_MTU,
    )
  })

  it('does nothing once the session is closed', () => {
    const session = switchable()
    Object.assign(session, { closed: true })
    session.switchLiveSource({ rtpBootstrap: () => [], parameterSets: null, reason: 'x' })
    expect(session.rtpRebasePending).toBe(false)
  })
})
