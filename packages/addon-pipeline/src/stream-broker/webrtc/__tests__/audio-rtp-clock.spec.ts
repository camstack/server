import { describe, it, expect } from 'vitest'
import {
  AUDIO_CLOCK_OPUS,
  AUDIO_CLOCK_PCMU,
  AUDIO_PT_OPUS,
  AUDIO_PT_PCMU,
  recordedAudioRebaseOffset,
  rtpTsFromMicros,
  selectAudioClock,
} from '../audio-rtp-clock'

describe('audio clocks', () => {
  it('PCMU is 8 kHz / 160-sample / PT 0', () => {
    expect(AUDIO_CLOCK_PCMU).toEqual({
      codec: 'pcmu',
      rateHz: 8_000,
      frameSamples: 160,
      payloadType: AUDIO_PT_PCMU,
    })
  })
  it('Opus is 48 kHz / 960-sample / PT 111', () => {
    expect(AUDIO_CLOCK_OPUS).toEqual({
      codec: 'opus',
      rateHz: 48_000,
      frameSamples: 960,
      payloadType: AUDIO_PT_OPUS,
    })
  })
  it('both use a 20 ms ptime (frameSamples == rateHz * 0.02)', () => {
    expect(AUDIO_CLOCK_PCMU.frameSamples).toBe(AUDIO_CLOCK_PCMU.rateHz * 0.02)
    expect(AUDIO_CLOCK_OPUS.frameSamples).toBe(AUDIO_CLOCK_OPUS.rateHz * 0.02)
  })
})

describe('selectAudioClock', () => {
  it('maps opus mime (any case) to the 48 kHz clock', () => {
    expect(selectAudioClock('audio/opus')).toBe(AUDIO_CLOCK_OPUS)
    expect(selectAudioClock('audio/OPUS')).toBe(AUDIO_CLOCK_OPUS)
  })
  it('maps PCMU / unknown / null to the 8 kHz baseline clock', () => {
    expect(selectAudioClock('audio/PCMU')).toBe(AUDIO_CLOCK_PCMU)
    expect(selectAudioClock('audio/something-else')).toBe(AUDIO_CLOCK_PCMU)
    expect(selectAudioClock(null)).toBe(AUDIO_CLOCK_PCMU)
    expect(selectAudioClock(undefined)).toBe(AUDIO_CLOCK_PCMU)
  })
})

describe('rtpTsFromMicros', () => {
  it('PCMU: 1 s of capture → 8000 ticks', () => {
    expect(rtpTsFromMicros(1_000_000, AUDIO_CLOCK_PCMU)).toBe(8_000)
  })
  it('Opus: 1 s of capture → 48000 ticks', () => {
    expect(rtpTsFromMicros(1_000_000, AUDIO_CLOCK_OPUS)).toBe(48_000)
  })
  it('20 ms → one frame of ticks per codec', () => {
    expect(rtpTsFromMicros(20_000, AUDIO_CLOCK_PCMU)).toBe(160)
    expect(rtpTsFromMicros(20_000, AUDIO_CLOCK_OPUS)).toBe(960)
  })
  it('preserves the legacy PCMU expression exactly', () => {
    const micros = 1_234_567
    expect(rtpTsFromMicros(micros, AUDIO_CLOCK_PCMU)).toBe(
      (micros * AUDIO_CLOCK_PCMU.rateHz) / 1_000_000,
    )
  })
})

describe('recordedAudioRebaseOffset', () => {
  it('PCMU: continues one 160-sample frame past the last sent ts', () => {
    // last=1000, incoming=5000 → offset makes outTs = incoming+offset = last+160.
    const off = recordedAudioRebaseOffset(1_000, 5_000, AUDIO_CLOCK_PCMU)
    expect(off).toBe((1_000 + 160 - 5_000) | 0)
    expect((5_000 + off) >>> 0).toBe(1_160)
  })
  it('Opus: continues one 960-sample frame past the last sent ts', () => {
    const off = recordedAudioRebaseOffset(1_000, 5_000, AUDIO_CLOCK_OPUS)
    expect((5_000 + off) >>> 0).toBe(1_960)
  })
  it('null last-sent anchors the recorded stream at its own zero (+frame)', () => {
    // Nothing sent yet: outTs = incoming + offset = 0 + frameSamples.
    const off = recordedAudioRebaseOffset(null, 5_000, AUDIO_CLOCK_OPUS)
    expect((5_000 + off) >>> 0).toBe(960)
  })
  it('matches the legacy PCMU inline formula', () => {
    const last = 42_000
    const incoming = 7_777
    expect(recordedAudioRebaseOffset(last, incoming, AUDIO_CLOCK_PCMU)).toBe(
      (last + 160 - incoming) | 0,
    )
  })
})
