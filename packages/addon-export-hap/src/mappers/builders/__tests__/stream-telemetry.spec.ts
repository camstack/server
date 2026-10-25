/**
 * Session telemetry — the accounting behind the one log line a future session
 * greps to answer "why did this session die".
 *
 * Two rules from `CLAUDE.md` drive this module:
 *   - "A branch that DROPS work silently logs it." Every early return on the
 *     streaming path books a NAMED reason here, so a session that forwarded
 *     nothing says which branch ate the packets instead of saying nothing.
 *   - Counters are immutable: `recordDrop` returns a new record. A shared
 *     mutable tally is exactly how a "0 drops" reading survives a bug.
 */
import { describe, expect, it } from 'vitest'

import {
  applyReceiverReportBlock,
  emptyReceiverReportTally,
  type ReceiverReportBlock,
} from '../rtcp-receiver-report.js'
import {
  classifyInboundPacket,
  emptyDropCounters,
  nonZeroDrops,
  recordDrop,
  type SessionTelemetrySnapshot,
  summariseSession,
} from '../stream-telemetry.js'

const CLEAN_BLOCK: ReceiverReportBlock = {
  aboutSsrc: 12345,
  fractionLostRaw: 0,
  fractionLostPct: 0,
  cumulativePacketsLost: 0,
  extendedHighestSequence: 5000,
  jitter: 90,
  lastSrTimestamp: 1,
  delaySinceLastSrMs: 40,
}

describe('recordDrop', () => {
  it('books each reason separately', () => {
    let counters = emptyDropCounters()
    counters = recordDrop(counters, 'upstream-pt-mismatch')
    counters = recordDrop(counters, 'upstream-pt-mismatch')
    counters = recordDrop(counters, 'no-srtp-session')

    expect(counters['upstream-pt-mismatch']).toBe(2)
    expect(counters['no-srtp-session']).toBe(1)
  })

  it('does not mutate the input', () => {
    const before = emptyDropCounters()
    const after = recordDrop(before, 'no-srtp-session')

    expect(before['no-srtp-session']).toBe(0)
    expect(after).not.toBe(before)
  })

  it('starts every known reason at zero so a reason cannot be silently absent', () => {
    const counters = emptyDropCounters()
    expect(Object.values(counters).every((v) => v === 0)).toBe(true)
    expect(Object.keys(counters).length).toBeGreaterThan(5)
  })
})

describe('nonZeroDrops', () => {
  it('renders only what actually happened — an all-zero tally is empty', () => {
    expect(nonZeroDrops(emptyDropCounters())).toEqual({})
  })

  it('keeps the reasons that fired', () => {
    const counters = recordDrop(recordDrop(emptyDropCounters(), 'srtp-encrypt-failed'), 'no-gate')
    expect(nonZeroDrops(counters)).toEqual({
      'srtp-encrypt-failed': 1,
      'no-gate': 1,
    })
  })
})

describe('classifyInboundPacket', () => {
  it('recognises an RTCP Sender Report (PT 200)', () => {
    // V=2, PT=200 (SR).
    expect(classifyInboundPacket(Buffer.from([0x80, 200, 0x00, 0x06, 0, 0, 0, 0]))).toBe('rtcp')
  })

  it('recognises an RTCP Receiver Report (PT 201) — what iOS sends us', () => {
    expect(classifyInboundPacket(Buffer.from([0x81, 201, 0x00, 0x07, 0, 0, 0, 0]))).toBe('rtcp')
  })

  it('recognises RTP (a dynamic payload type, 96..127)', () => {
    expect(classifyInboundPacket(Buffer.from([0x80, 99, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'rtp',
    )
  })

  it('calls a runt packet malformed rather than guessing', () => {
    expect(classifyInboundPacket(Buffer.from([0x80]))).toBe('malformed')
  })
})

const SNAPSHOT: SessionTelemetrySnapshot = {
  sessionId: 'abc',
  startedAtMs: 1_000,
  endedAtMs: 24_100,
  videoKeyframes: 3,
  firstKeyframeAtMs: 5_200,
  maxKeyframeGapMs: 4_100,
  negotiated: {
    width: 1280,
    height: 720,
    fps: 30,
    maxBitrateKbps: 802,
    mtu: 1378,
    videoPt: 99,
    videoSsrc: 12345,
    videoRtcpIntervalMs: 5000,
    audioPt: 110,
    audioSsrc: 54321,
    audioSampleRateKhz: 24,
    audioPacketTimeMs: 20,
    audioRtcpIntervalMs: 5000,
    audioMaxBitrateKbps: 24,
  },
  selectedSlot: {
    profile: 'mid',
    brokerId: '101/mid',
    width: 1280,
    height: 720,
    advertisedFps: 10,
    advertisedFpsSource: 'measured',
    deliveredFps: 10,
    codec: 'h264',
    transcode: false,
    fitReason: 'source-fits-budget',
    publishedKbps: 512,
    measuredKbps: null,
    budgetKbps: 721,
    fitNotes: ['mid=512pub/?meas:fits'],
  },
  videoPacketsForwarded: 1000,
  audioPacketsForwarded: 1500,
  videoRtcpSrSent: 5,
  audioRtcpSrSent: 5,
  videoRtcpReceived: 0,
  audioRtcpReceived: 3,
  videoRtpReceived: 0,
  audioRtpReceived: 120,
  videoGate: { reason: 'timeout', waitedMs: 1000 },
  audioGate: { reason: 'packet', waitedMs: 42 },
  videoReceiverReports: emptyReceiverReportTally(),
  audioReceiverReports: emptyReceiverReportTally(),
  drops: recordDrop(emptyDropCounters(), 'upstream-pt-mismatch'),
  ffmpegExit: { code: 255, signal: null },
  stopRequestedByController: true,
  videoLoopback: {
    rcvbufRequestedBytes: 8 * 1024 * 1024,
    rcvbufEffectiveBytes: 16 * 1024 * 1024,
    rcvbufClamped: false,
    kernelDrops: 0,
  },
  audioLoopback: {
    rcvbufRequestedBytes: 1024 * 1024,
    rcvbufEffectiveBytes: 2 * 1024 * 1024,
    rcvbufClamped: false,
    kernelDrops: 0,
  },
}

describe('summariseSession', () => {
  it('dates the first key frame from the session START, not from its arrival', () => {
    // The number that matters is how long the controller stared at a loader.
    // Reporting the raw arrival clock would report the same value whether the
    // wait was 200 ms or 20 s, which is the whole question a blank HomeKit
    // stream poses — packets forwarded and zero loss say nothing about it.
    const meta = summariseSession(SNAPSHOT)
    expect(meta.msToFirstKeyframe).toBe(4_200)
    expect(meta.videoKeyframes).toBe(3)
    expect(meta.maxKeyframeGapMs).toBe(4_100)
  })

  it('reports NO key frame as null rather than as zero wait', () => {
    // Zero would read as "arrived instantly" — the opposite of the truth.
    const meta = summariseSession({
      ...SNAPSHOT,
      firstKeyframeAtMs: null,
      videoKeyframes: 0,
    })
    expect(meta.msToFirstKeyframe).toBeNull()
  })

  it('carries every fact the 31 s teardown investigation had to guess at', () => {
    const meta = summariseSession(SNAPSHOT)

    expect(meta.durationMs).toBe(23_100)
    // Who tore it down.
    expect(meta.stopRequestedByController).toBe(true)
    expect(meta.ffmpegExitCode).toBe(255)
    // Whether the controller ever talked back on each leg — the assumption
    // that could not be checked before.
    expect(meta.videoRtcpReceived).toBe(0)
    expect(meta.audioRtcpReceived).toBe(3)
    // Real gate outcome per leg, not a bare "gate opened".
    expect(meta.videoGate).toBe('timeout@1000ms')
    expect(meta.audioGate).toBe('packet@42ms')
    // What we promised vs what we picked.
    expect(meta.negotiatedFps).toBe(30)
    expect(meta.advertisedFps).toBe(10)
    expect(meta.advertisedFpsSource).toBe('measured')
    expect(meta.selectedProfile).toBe('mid')
    // And every silent drop, named.
    expect(meta.drops).toEqual({ 'upstream-pt-mismatch': 1 })
  })

  it('flags a media-free session so "iOS got nothing" is not inferred from absence', () => {
    const meta = summariseSession({ ...SNAPSHOT, videoPacketsForwarded: 0 })
    expect(meta.videoPacketsForwarded).toBe(0)
    expect(meta.mediaStarved).toBe(true)
  })

  it('does not flag a session that forwarded video', () => {
    expect(summariseSession(SNAPSHOT).mediaStarved).toBe(false)
  })

  describe('the loopback receive buffer — the 93-vs-1497 experiment', () => {
    it('reports what was ASKED for and what the kernel GRANTED, separately', () => {
      // A request clamped at `net.core.rmem_max` and a request honoured are
      // indistinguishable from one number. On a stock host both are 212 992.
      const meta = summariseSession(SNAPSHOT)
      expect(meta.videoLoopRcvbufRequestedBytes).toBe(8 * 1024 * 1024)
      expect(meta.videoLoopRcvbufBytes).toBe(16 * 1024 * 1024)
      expect(meta.videoLoopRcvbufClamped).toBe(false)
      expect(meta.audioLoopRcvbufBytes).toBe(2 * 1024 * 1024)
    })

    it('makes a KERNEL drop distinguishable from a source-side gap', () => {
      // This is the entire point of the field. A datagram dropped for a full
      // receive buffer never reaches a `message` handler, so it lowers
      // `videoPacketsForwarded` exactly like a packet ffmpeg never wrote — and
      // the controller reports no loss for it either, because we never sent it.
      const meta = summariseSession({
        ...SNAPSHOT,
        videoPacketsForwarded: 93,
        videoLoopback: { ...SNAPSHOT.videoLoopback, kernelDrops: 4_211 },
      })
      expect(meta.videoLoopKernelDrops).toBe(4_211)
      expect(meta.videoLoopKernelDropped).toBe(true)
    })

    it('does not call an unreadable counter "no drops"', () => {
      // `/proc/net/udp` is Linux-only and the read can fail. "We could not
      // look" must not render as evidence the buffer held.
      const meta = summariseSession({
        ...SNAPSHOT,
        videoLoopback: { ...SNAPSHOT.videoLoopback, kernelDrops: null },
      })
      expect(meta.videoLoopKernelDrops).toBeNull()
      expect(meta.videoLoopKernelDropped).toBe(false)
    })
  })

  it('reports an unfinished session rather than a negative duration', () => {
    const meta = summariseSession({ ...SNAPSHOT, endedAtMs: null })
    expect(meta.durationMs).toBeNull()
  })

  it('says whether the stream we sent FITTED the rate that was negotiated (R5)', () => {
    // The 2026-08-06 session forwarded ~421 kbps against a negotiated 299 and
    // nothing in the summary could have shown that. These five fields can.
    const meta = summariseSession(SNAPSHOT)

    expect(meta.fitReason).toBe('source-fits-budget')
    expect(meta.slotPublishedKbps).toBe(512)
    expect(meta.encodeBudgetKbps).toBe(721)
    expect(meta.deliveredFps).toBe(10)
    expect(meta.fitNotes).toEqual(['mid=512pub/?meas:fits'])
  })

  it('leaves the fit fields null for a session that never selected a slot', () => {
    const meta = summariseSession({ ...SNAPSHOT, selectedSlot: null })
    expect(meta.fitReason).toBeNull()
    expect(meta.encodeBudgetKbps).toBeNull()
    expect(meta.fitNotes).toEqual([])
  })
})

/**
 * The summary's job after 2026-08-06 is no longer "did the controller talk to
 * us" — the telemetry settled that, it does. It is "what did the controller
 * SAY", because the answer splits the remaining causes into two disjoint
 * families and nothing else in the system can.
 */
describe('summariseSession — the controller’s own verdict', () => {
  it('carries the receiver-report roll-up per leg', () => {
    const reports = applyReceiverReportBlock(
      applyReceiverReportBlock(emptyReceiverReportTally(), {
        ...CLEAN_BLOCK,
        fractionLostPct: 12.5,
        cumulativePacketsLost: 40,
        jitter: 4000,
      }),
      {
        ...CLEAN_BLOCK,
        fractionLostPct: 0.4,
        cumulativePacketsLost: 41,
        jitter: 120,
      },
    )
    const meta = summariseSession({
      ...SNAPSHOT,
      videoReceiverReports: reports,
    })

    expect(meta.videoReceiverReports.lastFractionLostPct).toBe(0.4)
    expect(meta.videoReceiverReports.worstFractionLostPct).toBe(12.5)
    expect(meta.videoReceiverReports.lastCumulativePacketsLost).toBe(41)
    expect(meta.videoReceiverReports.maxJitter).toBe(4000)
    expect(meta.videoReceiverReports.lastExtendedHighestSequence).toBe(5000)
  })

  it('says "no-reports" when nothing readable ever came back — never "loss free"', () => {
    expect(summariseSession(SNAPSHOT).videoLossVerdict).toBe('no-reports')
  })

  it('points at the transmit side when the controller reports real loss', () => {
    const lossy = applyReceiverReportBlock(emptyReceiverReportTally(), {
      ...CLEAN_BLOCK,
      fractionLostPct: 63.7,
    })
    const meta = summariseSession({ ...SNAPSHOT, videoReceiverReports: lossy })
    expect(meta.videoLossVerdict).toBe('transmit-suspect')
  })

  it('points at the decode side when the controller says it received everything', () => {
    const clean = applyReceiverReportBlock(emptyReceiverReportTally(), CLEAN_BLOCK)
    const meta = summariseSession({ ...SNAPSHOT, videoReceiverReports: clean })
    expect(meta.videoLossVerdict).toBe('decode-suspect')
  })

  it('treats RTCP that arrived but could not be read as "no-reports"', () => {
    const unreadable = { ...emptyReceiverReportTally(), unreadable: 9 }
    const meta = summariseSession({
      ...SNAPSHOT,
      videoReceiverReports: unreadable,
    })
    expect(meta.videoLossVerdict).toBe('no-reports')
    expect(meta.videoReceiverReports.unreadable).toBe(9)
  })
})
