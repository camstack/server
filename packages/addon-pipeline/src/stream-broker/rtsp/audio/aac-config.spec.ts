import { describe, it, expect } from 'vitest'
import { parseAudioSpecificConfig, depacketizeRfc3640 } from './aac-config.js'

describe('parseAudioSpecificConfig', () => {
  it('parses AAC-LC mono 16kHz', () => {
    // 5 bits objType=2 (00010) + 4 bits srIdx=8 (1000, 16000Hz)
    // + 4 bits chCfg=1 (0001) = 13 bits, padded → 0x14 0x08
    const cfg = parseAudioSpecificConfig('1408')
    expect(cfg.objectType).toBe(2)
    expect(cfg.sampleRate).toBe(16000)
    expect(cfg.channelConfig).toBe(1)
  })

  it('parses AAC-LC stereo 8kHz', () => {
    // objType=2 (00010) + srIdx=11 (1011, 8000Hz) + chCfg=2 (0010)
    // = 00010_1011_0010, padded → 0x15 0x90
    const cfg = parseAudioSpecificConfig('1590')
    expect(cfg.objectType).toBe(2)
    expect(cfg.sampleRate).toBe(8000)
    expect(cfg.channelConfig).toBe(2)
  })

  it('parses HE-AAC v2 (objectType 29 via escape) — basic shape', () => {
    // 11111 (escape) 110 (29-32 = -3 → 6-bit obj=000110 = 6 → 32+6=38)
    // Quick sanity: parseAudioSpecificConfig returns correct objectType
    // once a real escape blob is supplied. We only test the escape path
    // accepts well-formed input without throwing.
    expect(() => parseAudioSpecificConfig('f8c100')).not.toThrow()
  })

  it('rejects empty / odd-length hex', () => {
    expect(() => parseAudioSpecificConfig('')).toThrow()
    expect(() => parseAudioSpecificConfig('1')).toThrow()
  })
})

describe('depacketizeRfc3640', () => {
  it('returns empty when payload too short', () => {
    expect(depacketizeRfc3640(new Uint8Array([0]))).toEqual([])
    expect(depacketizeRfc3640(new Uint8Array(0))).toEqual([])
  })

  it('extracts a single AU with sizeLength=13 indexLength=3', () => {
    // size=4 (13 bits) + idx=0 (3 bits) = 16 bits total
    //   13 bits MSB-first for 4: 0000000000100
    //   concat with idx 000      : 0000000000100000 → 0x00 0x20
    // header-length-prefix: 16 bits → 0x00 0x10
    const payload = new Uint8Array([
      0x00,
      0x10, // AU-headers bit-length = 16
      0x00,
      0x20, // size=4, index=0
      0xaa,
      0xbb,
      0xcc,
      0xdd, // AU bytes
    ])
    const units = depacketizeRfc3640(payload)
    expect(units).toHaveLength(1)
    expect(Array.from(units[0]!)).toEqual([0xaa, 0xbb, 0xcc, 0xdd])
  })

  it('extracts two AUs with size + index-delta', () => {
    // AU#1: size=3 (13 bits) + idx=0      (3 bits) =  0000000000011 000
    //   bytes:                                       0x00 0x18
    // AU#2: size=2 (13 bits) + delta=1    (3 bits) =  0000000000010 001
    //   bytes:                                       0x00 0x11
    // headers bit-length = 32 → 0x00 0x20
    const payload = new Uint8Array([
      0x00,
      0x20,
      0x00,
      0x18, // sz=3 idx=0
      0x00,
      0x11, // sz=2 delta=1
      0x11,
      0x22,
      0x33, // AU#1 (3 bytes)
      0x44,
      0x55, // AU#2 (2 bytes)
    ])
    const units = depacketizeRfc3640(payload)
    expect(units).toHaveLength(2)
    expect(Array.from(units[0]!)).toEqual([0x11, 0x22, 0x33])
    expect(Array.from(units[1]!)).toEqual([0x44, 0x55])
  })

  it('returns empty when AU data is shorter than headers claim', () => {
    // Headers say one AU of size 4 but payload has only 1 trailing byte.
    const payload = new Uint8Array([0x00, 0x10, 0x00, 0x20, 0xff])
    expect(depacketizeRfc3640(payload)).toEqual([])
  })
})
