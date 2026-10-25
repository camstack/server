/**
 * Unit tests for `computeAudioSilencePadPackets` — the pure helper that decides
 * how many PCMU silence packets to pre-stream BEFORE the first real audio
 * packet in a WebRTC session, to close the constant startup gap between video
 * `firstSendWallMs` and audio `firstSendWallMs` (the "audio plays ~1s behind
 * video" symptom on transcoded sources, see `emitAvSyncDiag` in
 * `webrtc/session.ts`).
 *
 * Conventions (documented here so the implementation matches):
 *
 *  - PCMU @ 8 kHz, 20 ms / 160 samples per packet. Each silence packet carries
 *    160 bytes of 0xFF (PCMU silence) — the wire frame size and one-packet
 *    duration in ms is `framesizeSamples / rateHz * 1000`.
 *  - When `firstVideoSendWallMs` is null (video hasn't sent yet) we emit 0 —
 *    nothing to align to.
 *  - When the gap (`nowMs − firstVideoSendWallMs`) is ≤ 0 (audio first, or
 *    same instant) we emit 0 — no audio-late lag to close.
 *  - When the gap is positive but smaller than one packet (< 20 ms at 8 kHz/160)
 *    we emit 0 — sub-packet alignment is below the codec's frame resolution and
 *    a single packet would over-shoot.
 *  - For gaps of one packet or more we emit `ceil(gap / frameMs)` packets so
 *    silence FULLY covers (or slightly over-covers) the gap.
 *  - The packet count is capped at `ceil(maxPadMs / frameMs)` so a runaway
 *    can't blast tens of seconds of silence onto the wire.
 */
import { describe, it, expect } from 'vitest'
import { computeAudioSilencePadPackets, planAudioSilencePadPackets } from '../webrtc/session.js'

const PCMU_RATE_HZ = 8_000
const PCMU_FRAMESIZE_SAMPLES = 160
const PCMU_FRAME_MS = (PCMU_FRAMESIZE_SAMPLES / PCMU_RATE_HZ) * 1000 // 20 ms
const MAX_PAD_MS = 2_000

const baseInput = {
  framesizeSamples: PCMU_FRAMESIZE_SAMPLES,
  rateHz: PCMU_RATE_HZ,
  maxPadMs: MAX_PAD_MS,
}

describe('computeAudioSilencePadPackets', () => {
  it('returns 0 when video has not sent yet (firstVideoSendWallMs is null)', () => {
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_000,
      firstVideoSendWallMs: null,
    })
    expect(n).toBe(0)
  })

  it('returns 0 when the gap is exactly zero', () => {
    const t = 1_000_000
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      nowMs: t,
      firstVideoSendWallMs: t,
    })
    expect(n).toBe(0)
  })

  it('returns 0 when the gap is negative (audio first, then video)', () => {
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_000,
      firstVideoSendWallMs: 1_000_500,
    })
    expect(n).toBe(0)
  })

  it('returns 0 when the gap is below one packet (< 20 ms)', () => {
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_010,
      firstVideoSendWallMs: 1_000_000,
    })
    expect(n).toBe(0)
  })

  it('covers a single full packet when the gap equals one frame duration', () => {
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_020,
      firstVideoSendWallMs: 1_000_000,
    })
    expect(n).toBe(1)
  })

  it('returns ceil(gap/frameMs) for the 401 ms transcoded-audio case (Carol)', () => {
    // Carol — Reolink/AAC: firstSendGapMs = +401 ms constant → ceil(401/20) = 21.
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_401,
      firstVideoSendWallMs: 1_000_000,
    })
    expect(n).toBe(21)
  })

  it('caps at ceil(maxPadMs / frameMs) when the gap exceeds maxPadMs', () => {
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_030_000, // 30 s gap
      firstVideoSendWallMs: 1_000_000,
    })
    expect(n).toBe(Math.ceil(MAX_PAD_MS / PCMU_FRAME_MS)) // 100 packets at 20 ms / 2000 ms cap
  })

  it('caps at the boundary when the gap equals maxPadMs exactly', () => {
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_002_000,
      firstVideoSendWallMs: 1_000_000,
    })
    expect(n).toBe(Math.ceil(MAX_PAD_MS / PCMU_FRAME_MS))
  })

  it('returns 0 when the framesizeSamples is non-positive (defensive)', () => {
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      framesizeSamples: 0,
      nowMs: 1_000_401,
      firstVideoSendWallMs: 1_000_000,
    })
    expect(n).toBe(0)
  })

  it('returns 0 when the rateHz is non-positive (defensive)', () => {
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      rateHz: 0,
      nowMs: 1_000_401,
      firstVideoSendWallMs: 1_000_000,
    })
    expect(n).toBe(0)
  })

  it('returns 0 when maxPadMs is zero (silence pre-stream disabled)', () => {
    const n = computeAudioSilencePadPackets({
      ...baseInput,
      maxPadMs: 0,
      nowMs: 1_000_401,
      firstVideoSendWallMs: 1_000_000,
    })
    expect(n).toBe(0)
  })
})

/**
 * `planAudioSilencePadPackets` covers the integration shape: given the count
 * `computeAudioSilencePadPackets` decides, produce the concrete (rtpTs, seq)
 * sequence the audio writer emits before the first real packet, and the
 * `audioSeqNum` to carry forward. The asserts here protect the "no gap, no
 * overlap" contract — silence runs `[realRtpTs − N·160, realRtpTs)` in ts and
 * `[audioSeqNum+1, audioSeqNum+N]` in seq, then the REAL packet (constructed
 * outside this helper) sits at `realRtpTs` / `audioSeqNum+N+1`.
 */
describe('planAudioSilencePadPackets', () => {
  it('returns an empty plan when nothing needs padding (firstVideoSendWallMs null)', () => {
    const plan = planAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_000,
      firstVideoSendWallMs: null,
      realRtpTs: 160,
      audioSeqNum: 42,
    })
    expect(plan.packets).toEqual([])
    expect(plan.nextAudioSeqNum).toBe(42)
  })

  it('packs the 401 ms Carol case as 21 silence packets ending one before the real ts', () => {
    const realRtpTs = 160
    const audioSeqNum = 1_000
    const plan = planAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_401,
      firstVideoSendWallMs: 1_000_000,
      realRtpTs,
      audioSeqNum,
    })
    expect(plan.packets).toHaveLength(21)
    // FIRST silence packet timestamp = realRtpTs − N·160 (mod 2^32).
    const firstSilenceRtpTs = (realRtpTs - 21 * PCMU_FRAMESIZE_SAMPLES) >>> 0
    expect(plan.packets[0]!.rtpTs).toBe(firstSilenceRtpTs)
    // LAST silence packet timestamp = realRtpTs − 160 — i.e. exactly one
    // frame before the real packet (no gap, no overlap).
    expect(plan.packets[20]!.rtpTs).toBe((realRtpTs - PCMU_FRAMESIZE_SAMPLES) >>> 0)
    // Sequence numbers are CONTIGUOUS from audioSeqNum + 1, and the next real
    // packet will land at nextAudioSeqNum + 1 = audioSeqNum + 22.
    expect(plan.packets[0]!.seq).toBe(audioSeqNum + 1)
    expect(plan.packets[20]!.seq).toBe(audioSeqNum + 21)
    expect(plan.nextAudioSeqNum).toBe(audioSeqNum + 21)
  })

  it('produces packets with strictly increasing ts (by frameSize) and seq (by 1)', () => {
    const plan = planAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_200, // gap = 200 ms → 10 packets
      firstVideoSendWallMs: 1_000_000,
      realRtpTs: 5_000,
      audioSeqNum: 0,
    })
    expect(plan.packets).toHaveLength(10)
    for (let i = 1; i < plan.packets.length; i++) {
      expect(plan.packets[i]!.rtpTs).toBe(
        (plan.packets[i - 1]!.rtpTs + PCMU_FRAMESIZE_SAMPLES) >>> 0,
      )
      expect(plan.packets[i]!.seq).toBe((plan.packets[i - 1]!.seq + 1) & 0xffff)
    }
  })

  it('keeps ts/seq continuous into the REAL packet (no gap, no overlap)', () => {
    const realRtpTs = 3_200
    const audioSeqNum = 500
    const plan = planAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_401, // 21 packets
      firstVideoSendWallMs: 1_000_000,
      realRtpTs,
      audioSeqNum,
    })
    const last = plan.packets[plan.packets.length - 1]!
    // Real packet's ts is exactly one frameSize past the last silence ts.
    expect((last.rtpTs + PCMU_FRAMESIZE_SAMPLES) >>> 0).toBe(realRtpTs)
    // And the real packet's seq is exactly one past the carry-forward seq.
    expect((plan.nextAudioSeqNum + 1) & 0xffff).toBe(audioSeqNum + 22)
  })

  it('wraps the sequence number modulo 16 bits across the silence run', () => {
    // audioSeqNum near 0xffff so the silence run forces a 16-bit wrap.
    const plan = planAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_100, // gap = 100 ms → 5 packets
      firstVideoSendWallMs: 1_000_000,
      realRtpTs: 10_000,
      audioSeqNum: 0xfffd,
    })
    expect(plan.packets).toHaveLength(5)
    expect(plan.packets[0]!.seq).toBe(0xfffe)
    expect(plan.packets[1]!.seq).toBe(0xffff)
    expect(plan.packets[2]!.seq).toBe(0x0000)
    expect(plan.packets[3]!.seq).toBe(0x0001)
    expect(plan.packets[4]!.seq).toBe(0x0002)
    expect(plan.nextAudioSeqNum).toBe(0x0002)
  })

  it('wraps the RTP timestamp modulo 32 bits when the real ts is smaller than N·160', () => {
    // realRtpTs < N · 160 → first silence ts wraps into the upper 32-bit range.
    const realRtpTs = 100
    const plan = planAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_000_401, // 21 packets → 21·160 = 3360 samples back
      firstVideoSendWallMs: 1_000_000,
      realRtpTs,
      audioSeqNum: 0,
    })
    const expectedFirst = (realRtpTs - 21 * PCMU_FRAMESIZE_SAMPLES) >>> 0
    expect(plan.packets[0]!.rtpTs).toBe(expectedFirst)
    // Last silence is exactly one frame before realRtpTs (no overlap).
    expect(plan.packets[20]!.rtpTs).toBe((realRtpTs - PCMU_FRAMESIZE_SAMPLES) >>> 0)
  })

  it('caps the plan at maxPadMs (100 packets for the default 2000 ms cap)', () => {
    const plan = planAudioSilencePadPackets({
      ...baseInput,
      nowMs: 1_030_000, // 30 s gap → would be 1500 packets without the cap
      firstVideoSendWallMs: 1_000_000,
      realRtpTs: 200_000,
      audioSeqNum: 0,
    })
    expect(plan.packets).toHaveLength(Math.ceil(MAX_PAD_MS / PCMU_FRAME_MS))
  })
})
