/**
 * D733 — the two pure halves of an in-place tier switch: whether the session
 * can carry the new rendition as negotiated, and the make-before-break that
 * commits it only on a keyframe.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import type { IStreamBroker, Unsubscribe } from '@camstack/types'
import {
  bindPendingSource,
  judgeInPlaceSwitch,
  sessionCodecOf,
  type InPlaceSessionShape,
  type InPlaceTargetShape,
} from '../in-place-tier-switch.js'

type EncodedDataListener = Parameters<IStreamBroker['onEncodedData']>[0]

const SESSION: InPlaceSessionShape = {
  recorded: false,
  forceTranscodeDown: false,
  useRtpRepacketizer: true,
  needsTranscode: false,
  sessionCodec: 'H264',
  audioCodec: 'PCMU',
  usesOpusEgress: false,
}

const TARGET: InPlaceTargetShape = {
  tierMatches: true,
  isRtp: true,
  codec: 'H264',
  needsBaselineTranscode: false,
  audioCodec: 'pcmu',
  supportsOpusEgress: false,
}

describe('judgeInPlaceSwitch', () => {
  it('same codec, passthrough RTP, same audio: stays on the session', () => {
    expect(judgeInPlaceSwitch(SESSION, TARGET)).toBeNull()
  })

  it.each([
    ['recorded', { ...SESSION, recorded: true }, TARGET],
    ['transcode-down', { ...SESSION, forceTranscodeDown: true }, TARGET],
    ['not-rtp-passthrough', { ...SESSION, useRtpRepacketizer: false }, TARGET],
    ['transcode', { ...SESSION, needsTranscode: true }, TARGET],
    ['tier-unavailable', SESSION, { ...TARGET, tierMatches: false }],
    ['target-not-rtp', SESSION, { ...TARGET, isRtp: false }],
    // Camera 106 on this hub: main H.265, sub H.264.
    ['codec-differs', SESSION, { ...TARGET, codec: 'H265' as const }],
    ['target-needs-transcode', SESSION, { ...TARGET, needsBaselineTranscode: true }],
    ['audio-codec-differs', SESSION, { ...TARGET, audioCodec: 'OPUS' }],
    [
      'opus-egress-unsupported',
      { ...SESSION, usesOpusEgress: true },
      { ...TARGET, supportsOpusEgress: false },
    ],
  ] as const)('refuses by name: %s', (reason, session, target) => {
    expect(judgeInPlaceSwitch(session, target)).toBe(reason)
  })

  it('a cold target whose codec and audio are not known yet is not refused — commit re-judges', () => {
    expect(
      judgeInPlaceSwitch(SESSION, { ...TARGET, codec: null, audioCodec: undefined }),
    ).toBeNull()
  })

  it('a target without audio matches a session without audio', () => {
    expect(
      judgeInPlaceSwitch({ ...SESSION, audioCodec: null }, { ...TARGET, audioCodec: null }),
    ).toBeNull()
  })

  it('maps broker codec strings onto the session codec', () => {
    expect(sessionCodecOf('hevc')).toBe('H265')
    expect(sessionCodecOf('h265')).toBe('H265')
    expect(sessionCodecOf('h264')).toBe('H264')
    expect(sessionCodecOf(undefined)).toBeNull()
  })
})

/** A broker that delivers RTP on demand and exposes its pre-buffer. */
class FakeRtpBroker {
  readonly preBuffer: Buffer[] = []
  readonly rtpCbs = new Set<(rtp: Buffer) => void>()
  readonly encodedCbs = new Set<EncodedDataListener>()
  /** Deliver one packet: captured into the pre-buffer BEFORE fan-out, as the real broker does. */
  emit(rtp: Buffer, keyframe = false): void {
    if (keyframe) this.preBuffer.length = 0
    if (keyframe || this.preBuffer.length > 0) this.preBuffer.push(rtp)
    for (const cb of [...this.rtpCbs]) cb(rtp)
  }
  asBroker(): IStreamBroker {
    const self = this
    const partial: Pick<IStreamBroker, 'onVideoRtp' | 'onEncodedData' | 'getRtpPreBuffer'> = {
      onVideoRtp(cb: (rtp: Buffer) => void): Unsubscribe {
        self.rtpCbs.add(cb)
        return () => self.rtpCbs.delete(cb)
      },
      onEncodedData(cb: EncodedDataListener): Unsubscribe {
        self.encodedCbs.add(cb)
        return () => self.encodedCbs.delete(cb)
      },
      getRtpPreBuffer: () => self.preBuffer,
    }
    return partial as IStreamBroker
  }
}

describe('bindPendingSource — make-before-break', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const pkt = (n: number): Buffer => Buffer.from([n])

  it('does not commit on packets before the first keyframe, then commits and forwards the committing packet', () => {
    const fake = new FakeRtpBroker()
    const forwarded: number[] = []
    const commit = vi.fn(() => true)
    const pending = bindPendingSource({
      broker: fake.asBroker(),
      attribution: { kind: 'webrtc-browser' },
      timeoutMs: 8_000,
      commit,
      forward: (rtp) => forwarded.push(rtp[0]!),
      onTimeout: vi.fn(),
    })
    fake.emit(pkt(1)) // mid-GOP: nothing to start a decoder on
    fake.emit(pkt(2))
    expect(commit).not.toHaveBeenCalled()
    expect(forwarded).toEqual([])
    fake.emit(pkt(3), true) // the keyframe
    expect(commit).toHaveBeenCalledTimes(1)
    expect(forwarded).toEqual([3])
    fake.emit(pkt(4))
    expect(forwarded).toEqual([3, 4])
    expect(pending.committed()).toBe(true)
    // ONE video subscription throughout; the warm-up consumer is gone after the commit.
    expect(fake.rtpCbs.size).toBe(1)
    expect(fake.encodedCbs.size).toBe(0)
  })

  it('keeps a warm-up consumer while pending, so a cold broker dials', () => {
    const fake = new FakeRtpBroker()
    bindPendingSource({
      broker: fake.asBroker(),
      attribution: { kind: 'webrtc-browser' },
      timeoutMs: 8_000,
      commit: () => true,
      forward: vi.fn(),
      onTimeout: vi.fn(),
    })
    expect(fake.encodedCbs.size).toBe(1)
  })

  it('a refused commit drops the subscription and forwards nothing', () => {
    const fake = new FakeRtpBroker()
    const forward = vi.fn()
    bindPendingSource({
      broker: fake.asBroker(),
      attribution: { kind: 'webrtc-browser' },
      timeoutMs: 8_000,
      commit: () => false,
      forward,
      onTimeout: vi.fn(),
    })
    fake.emit(pkt(1), true)
    expect(forward).not.toHaveBeenCalled()
    expect(fake.rtpCbs.size).toBe(0)
    expect(fake.encodedCbs.size).toBe(0)
  })

  it('no keyframe within the budget: times out, unsubscribes, never commits', () => {
    const fake = new FakeRtpBroker()
    const commit = vi.fn(() => true)
    const onTimeout = vi.fn()
    bindPendingSource({
      broker: fake.asBroker(),
      attribution: { kind: 'webrtc-browser' },
      timeoutMs: 8_000,
      commit,
      forward: vi.fn(),
      onTimeout,
    })
    fake.emit(pkt(1))
    vi.advanceTimersByTime(8_000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(fake.rtpCbs.size).toBe(0)
    fake.emit(pkt(2), true)
    expect(commit).not.toHaveBeenCalled()
  })

  it('unsubscribe before the commit cancels the timer and the subscription', () => {
    const fake = new FakeRtpBroker()
    const onTimeout = vi.fn()
    const pending = bindPendingSource({
      broker: fake.asBroker(),
      attribution: { kind: 'webrtc-browser' },
      timeoutMs: 8_000,
      commit: () => true,
      forward: vi.fn(),
      onTimeout,
    })
    pending.unsubscribe()
    vi.advanceTimersByTime(10_000)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(fake.rtpCbs.size).toBe(0)
    expect(fake.encodedCbs.size).toBe(0)
  })
})
