import { describe, it, expect } from 'vitest'
import {
  parseFlvVideoTag,
  parseFlvVideoTagWithLengthSize,
  parseFlvAudioTag,
  buildH264ParamSetsAnnexB,
  buildH265ParamSetsAnnexB,
  nalusToAnnexB,
  looksLikeAdts,
  aacSamplingIndexToHz,
  AudioSoundFormat,
  UnsupportedCodecError,
  FlvParseError,
} from '../flv-parser'

// ── Helpers ────────────────────────────────────────────────────────────

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex')

// Minimal SPS NAL body: nal_unit_type=7 (low 5 bits of byte 0)
const SPS_BODY = hex('67 42 00 1e da 81 40 16 e0 22 00 00 03 00 02 00 00 03 00 79 1e 30 64 80')
// Minimal PPS NAL body: nal_unit_type=8
const PPS_BODY = hex('68 ce 06 e2')

// HEVC: VPS=32, SPS=33, PPS=34 in low 6 bits of byte 0 (nal_unit_type<<1)
// VPS header byte = 0x40 (32 << 1)
const VPS_BODY = hex('40 01 0c 01 ff ff 01 60 00 00 03 00 90 00 00 03 00 00 03 00 78 9d c0 90')
// SPS header byte = 0x42 (33 << 1)
const HEVC_SPS_BODY = hex(
  '42 01 01 01 60 00 00 03 00 90 00 00 03 00 00 03 00 78 a0 03 c0 80 10 e5 96 56 6a a4 c5 0d ee fe a3 80',
)
// PPS header byte = 0x44 (34 << 1)
const HEVC_PPS_BODY = hex('44 01 c0 73 c0 cc 90')

// ── H.264 sequence header ─────────────────────────────────────────────

describe('parseFlvVideoTag — H.264 SequenceHeader', () => {
  it('extracts SPS, PPS, profile, and level', () => {
    // FLV video tag header: frameType=1 (KEY), codecId=7 (H264) → 0x17
    // avcPacketType=0 (SEQUENCE_HEADER), compositionTime=0
    const tagHeader = hex('17 00 00 00 00')

    // AVCDecoderConfigurationRecord:
    //   version=1, profile=0x42 (Baseline), profileCompat=0x00, level=0x1e (3.0)
    //   lengthSizeMinusOne=3 (4-byte NALU length) → 0xff
    //   numSPS=1 (top 3 bits reserved=111) → 0xe1
    //   SPS length(2) + SPS body
    //   numPPS=1
    //   PPS length(2) + PPS body
    const configHeader = hex('01 42 00 1e ff e1')
    const spsLen = Buffer.alloc(2)
    spsLen.writeUInt16BE(SPS_BODY.length, 0)
    const numPps = Buffer.from([0x01])
    const ppsLen = Buffer.alloc(2)
    ppsLen.writeUInt16BE(PPS_BODY.length, 0)
    const config = Buffer.concat([configHeader, spsLen, SPS_BODY, numPps, ppsLen, PPS_BODY])

    const tag = parseFlvVideoTag(Buffer.concat([tagHeader, config]))

    expect(tag.kind).toBe('video-sequence-header')
    if (tag.kind !== 'video-sequence-header') return
    expect(tag.codec).toBe('h264')
    if (tag.codec !== 'h264') return
    expect(tag.avcConfig.avcProfileIndication).toBe(0x42)
    expect(tag.avcConfig.avcLevelIndication).toBe(0x1e)
    expect(tag.avcConfig.lengthSizeMinusOne).toBe(3)
    expect(tag.avcConfig.sps).toHaveLength(1)
    expect(tag.avcConfig.sps[0]?.equals(SPS_BODY) ?? false).toBe(true)
    expect(tag.avcConfig.pps).toHaveLength(1)
    expect(tag.avcConfig.pps[0]?.equals(PPS_BODY) ?? false).toBe(true)
  })
})

// ── H.264 NALU payload ────────────────────────────────────────────────

describe('parseFlvVideoTag — H.264 CodedFrames', () => {
  it('extracts NAL units with default 4-byte length size', () => {
    // frameType=1 KEY, codecId=7 H264 → 0x17
    // avcPacketType=1 NALU, compositionTime=0
    const tagHeader = hex('17 01 00 00 00')

    // Two NALUs: SPS body + PPS body, each preceded by 4-byte BE length
    const nalu1Len = Buffer.alloc(4)
    nalu1Len.writeUInt32BE(SPS_BODY.length, 0)
    const nalu2Len = Buffer.alloc(4)
    nalu2Len.writeUInt32BE(PPS_BODY.length, 0)
    const payload = Buffer.concat([nalu1Len, SPS_BODY, nalu2Len, PPS_BODY])

    const tag = parseFlvVideoTag(Buffer.concat([tagHeader, payload]))
    expect(tag.kind).toBe('video-coded-frames')
    if (tag.kind !== 'video-coded-frames') return
    expect(tag.codec).toBe('h264')
    expect(tag.nalus).toHaveLength(2)
    expect(tag.nalus[0]?.equals(SPS_BODY) ?? false).toBe(true)
    expect(tag.nalus[1]?.equals(PPS_BODY) ?? false).toBe(true)
  })

  it('honours the length-size override (2 bytes)', () => {
    const tagHeader = hex('27 01 00 00 00') // frameType=2 INTER
    const nalu1Len = Buffer.alloc(2)
    nalu1Len.writeUInt16BE(PPS_BODY.length, 0)
    const payload = Buffer.concat([nalu1Len, PPS_BODY])

    const tag = parseFlvVideoTagWithLengthSize(Buffer.concat([tagHeader, payload]), 2)
    expect(tag.kind).toBe('video-coded-frames')
    if (tag.kind !== 'video-coded-frames') return
    expect(tag.nalus).toHaveLength(1)
    expect(tag.nalus[0]?.equals(PPS_BODY) ?? false).toBe(true)
  })

  it('rejects unsupported codecs', () => {
    // codecId=4 (ON2_VP6) — outside our scope
    expect(() => parseFlvVideoTag(hex('14 00 00 00 00'))).toThrow(UnsupportedCodecError)
  })
})

// ── codecId=12 (Reolink legacy H.265-over-FLV) ────────────────────────

describe('parseFlvVideoTag — codecId=12 (Reolink legacy H.265)', () => {
  it('treats codecId=12 as H.265 with the standard FLV layout', () => {
    // byte 0: frameType=1 KEY << 4 | codecId=12 → 0x1c
    // packetType=0 SEQUENCE_HEADER, compositionTime=0
    const tagHeader = hex('1c 00 00 00 00')

    // Same minimal HVCC fixture as the enhanced-FLV test
    const fixed22 = hex('01 01 60 00 00 00 90 00 00 00 00 00 78 f0 00 fc fd f8 f8 00 00 0f')
    const numArrays = Buffer.from([0x03])

    const vpsLen = Buffer.alloc(2)
    vpsLen.writeUInt16BE(VPS_BODY.length, 0)
    const vpsArr = Buffer.concat([Buffer.from([0xa0]), hex('00 01'), vpsLen, VPS_BODY])

    const spsLen = Buffer.alloc(2)
    spsLen.writeUInt16BE(HEVC_SPS_BODY.length, 0)
    const spsArr = Buffer.concat([Buffer.from([0xa1]), hex('00 01'), spsLen, HEVC_SPS_BODY])

    const ppsLen = Buffer.alloc(2)
    ppsLen.writeUInt16BE(HEVC_PPS_BODY.length, 0)
    const ppsArr = Buffer.concat([Buffer.from([0xa2]), hex('00 01'), ppsLen, HEVC_PPS_BODY])

    const hvcc = Buffer.concat([fixed22, numArrays, vpsArr, spsArr, ppsArr])

    const tag = parseFlvVideoTag(Buffer.concat([tagHeader, hvcc]))
    expect(tag.kind).toBe('video-sequence-header')
    if (tag.kind !== 'video-sequence-header') return
    expect(tag.codec).toBe('h265')
    if (tag.codec !== 'h265') return
    expect(tag.hevcConfig.lengthSizeMinusOne).toBe(3)
    expect(tag.hevcConfig.vps).toHaveLength(1)
    expect(tag.hevcConfig.sps).toHaveLength(1)
    expect(tag.hevcConfig.pps).toHaveLength(1)
  })

  it('extracts NALUs with composition-time when packetType=1', () => {
    // byte 0: frameType=2 INTER << 4 | codecId=12 → 0x2c
    // packetType=1 NALU, compositionTime=33ms
    const tagHeader = hex('2c 01 00 00 21')
    const naluLen = Buffer.alloc(4)
    naluLen.writeUInt32BE(HEVC_PPS_BODY.length, 0)
    const tag = parseFlvVideoTag(Buffer.concat([tagHeader, naluLen, HEVC_PPS_BODY]))
    expect(tag.kind).toBe('video-coded-frames')
    if (tag.kind !== 'video-coded-frames') return
    expect(tag.codec).toBe('h265')
    expect(tag.compositionTime).toBe(33)
    expect(tag.nalus[0]?.equals(HEVC_PPS_BODY) ?? false).toBe(true)
  })
})

// ── Enhanced FLV — H.265 SequenceStart (HEVCDecoderConfigurationRecord) ─

describe('parseFlvVideoTag — Enhanced FLV H.265 SequenceStart', () => {
  it('extracts VPS, SPS, PPS via FOURCC=hvc1', () => {
    // byte 0: IsExHeader=1 | packetType=0 SEQUENCE_START | frameType=1 KEY → 0x81
    // FOURCC = 'hvc1'
    const tagHeader = hex('81') // 1000_0001
    const fourcc = Buffer.from('hvc1', 'ascii')

    // HEVCDecoderConfigurationRecord — fixed 22-byte header + arrays.
    // We construct a minimal valid record:
    //   configurationVersion=1
    //   general_profile_space=0, tier=0, profile_idc=1 → byte = 0x01
    //   general_profile_compatibility_flags = 0x60000000
    //   general_constraint_indicator_flags  = 0x900000000000 (48 bits)
    //   general_level_idc = 0x78 (level 4.0)
    //   min_spatial_segmentation_idc=0 (with reserved 1111 nibble) → 0xf0 0x00
    //   parallelismType = 0 (with reserved 111111) → 0xfc
    //   chromaFormat = 1 (with reserved 111111) → 0xfd
    //   bitDepthLumaMinus8 = 0 (with reserved 11111) → 0xf8
    //   bitDepthChromaMinus8 = 0 (with reserved 11111) → 0xf8
    //   avgFrameRate = 0
    //   constantFrameRate=0|numTemporalLayers=1|temporalIdNested=1|lengthSizeMinusOne=3 → 0x0f
    //   numOfArrays = 3 (VPS, SPS, PPS)
    const fixed22 = hex('01 01 60 00 00 00 90 00 00 00 00 00 78 f0 00 fc fd f8 f8 00 00 0f')
    const numArrays = Buffer.from([0x03])

    // Each array: u8 (array_completeness=1, reserved=0, NAL_unit_type = 32/33/34) + u16 numNalus
    const vpsArr = Buffer.concat([
      Buffer.from([0xa0]), // 1 0 100000 → array_completeness=1, NAL_type=32 (VPS)
      hex('00 01'),
      Buffer.alloc(2)
        .fill(0)
        .map(() => 0) as unknown as Buffer, // placeholder, replaced below
    ])
    // Replace last 2 bytes with VPS length, then append VPS body
    const vpsLen = Buffer.alloc(2)
    vpsLen.writeUInt16BE(VPS_BODY.length, 0)
    const vpsArrFinal = Buffer.concat([Buffer.from([0xa0]), hex('00 01'), vpsLen, VPS_BODY])

    const spsLen = Buffer.alloc(2)
    spsLen.writeUInt16BE(HEVC_SPS_BODY.length, 0)
    const spsArr = Buffer.concat([Buffer.from([0xa1]), hex('00 01'), spsLen, HEVC_SPS_BODY])

    const ppsLen = Buffer.alloc(2)
    ppsLen.writeUInt16BE(HEVC_PPS_BODY.length, 0)
    const ppsArr = Buffer.concat([Buffer.from([0xa2]), hex('00 01'), ppsLen, HEVC_PPS_BODY])

    const hvcc = Buffer.concat([fixed22, numArrays, vpsArrFinal, spsArr, ppsArr])
    void vpsArr // silence the placeholder construction

    const tag = parseFlvVideoTag(Buffer.concat([tagHeader, fourcc, hvcc]))

    expect(tag.kind).toBe('video-sequence-header')
    if (tag.kind !== 'video-sequence-header') return
    expect(tag.codec).toBe('h265')
    if (tag.codec !== 'h265') return
    expect(tag.hevcConfig.lengthSizeMinusOne).toBe(3)
    expect(tag.hevcConfig.vps).toHaveLength(1)
    expect(tag.hevcConfig.sps).toHaveLength(1)
    expect(tag.hevcConfig.pps).toHaveLength(1)
    expect(tag.hevcConfig.vps[0]?.equals(VPS_BODY) ?? false).toBe(true)
    expect(tag.hevcConfig.sps[0]?.equals(HEVC_SPS_BODY) ?? false).toBe(true)
    expect(tag.hevcConfig.pps[0]?.equals(HEVC_PPS_BODY) ?? false).toBe(true)
  })
})

// ── Enhanced FLV — H.265 CodedFramesX (no compositionTime) ────────────

describe('parseFlvVideoTag — Enhanced FLV H.265 CodedFramesX', () => {
  it('extracts NAL units with no compositionTime offset', () => {
    // byte 0: IsExHeader=1 | packetType=3 CODED_FRAMES_X | frameType=2 INTER → 1011_0010 = 0xb2
    const tagHeader = hex('b2')
    const fourcc = Buffer.from('hvc1', 'ascii')
    const naluLen = Buffer.alloc(4)
    naluLen.writeUInt32BE(HEVC_PPS_BODY.length, 0)
    const payload = Buffer.concat([naluLen, HEVC_PPS_BODY])

    const tag = parseFlvVideoTag(Buffer.concat([tagHeader, fourcc, payload]))
    expect(tag.kind).toBe('video-coded-frames')
    if (tag.kind !== 'video-coded-frames') return
    expect(tag.codec).toBe('h265')
    expect(tag.compositionTime).toBe(0)
    expect(tag.nalus).toHaveLength(1)
    expect(tag.nalus[0]?.equals(HEVC_PPS_BODY) ?? false).toBe(true)
  })

  it('rejects unknown FOURCC', () => {
    // packetType=0 SEQUENCE_START | frameType=1 KEY → 0x81
    // FOURCC = 'av01' (AV1) — out of scope
    const data = Buffer.concat([hex('81'), Buffer.from('av01', 'ascii'), hex('00 00 00 00')])
    expect(() => parseFlvVideoTag(data)).toThrow(UnsupportedCodecError)
  })
})

// ── Enhanced FLV — H.265 CodedFrames (with compositionTime) ────────────

describe('parseFlvVideoTag — Enhanced FLV H.265 CodedFrames', () => {
  it('reads 24-bit signed compositionTime then NALU payload', () => {
    // byte 0: IsExHeader=1 | packetType=1 CODED_FRAMES | frameType=1 KEY → 1001_0001 = 0x91
    const tagHeader = hex('91')
    const fourcc = Buffer.from('hvc1', 'ascii')
    const compTime = hex('00 00 21') // 33 ms
    const naluLen = Buffer.alloc(4)
    naluLen.writeUInt32BE(HEVC_SPS_BODY.length, 0)
    const payload = Buffer.concat([naluLen, HEVC_SPS_BODY])

    const tag = parseFlvVideoTag(Buffer.concat([tagHeader, fourcc, compTime, payload]))
    expect(tag.kind).toBe('video-coded-frames')
    if (tag.kind !== 'video-coded-frames') return
    expect(tag.codec).toBe('h265')
    expect(tag.compositionTime).toBe(33)
    expect(tag.nalus[0]?.equals(HEVC_SPS_BODY) ?? false).toBe(true)
  })
})

// ── Audio: AAC sequence header ────────────────────────────────────────

describe('parseFlvAudioTag — AAC SequenceHeader', () => {
  it('extracts AudioSpecificConfig', () => {
    // soundFormat=AAC(10), soundRate=3 (44.1kHz), soundSize=1, soundType=1
    //   → byte 0 = (10 << 4) | (3 << 2) | (1 << 1) | 1 = 0xaf
    // aacPacketType=0 SEQUENCE_HEADER
    // ASC bytes: AOT=2 (AAC-LC), samplingFrequencyIndex=4 (44.1kHz), channels=2
    //   byte0 = (2 << 3) | (4 >> 1) = 0x12
    //   byte1 = ((4 & 1) << 7) | (2 << 3) = 0x10
    const tag = parseFlvAudioTag(hex('af 00 12 10'))
    expect(tag.kind).toBe('audio-sequence-header')
    if (tag.kind !== 'audio-sequence-header') return
    expect(tag.soundFormat).toBe(AudioSoundFormat.AAC)
    expect(tag.audioSpecificConfig.audioObjectType).toBe(2)
    expect(tag.audioSpecificConfig.samplingFrequencyIndex).toBe(4)
    expect(tag.audioSpecificConfig.channelConfiguration).toBe(2)
    expect(tag.audioSpecificConfigBytes.equals(hex('12 10'))).toBe(true)
  })

  it('extracts raw AAC frame after sequence header', () => {
    // byte0 = 0xaf (AAC), aacPacketType=1 RAW
    const aacFrame = hex('21 12 34 56')
    const tag = parseFlvAudioTag(Buffer.concat([hex('af 01'), aacFrame]))
    expect(tag.kind).toBe('audio-raw')
    if (tag.kind !== 'audio-raw') return
    expect(tag.soundFormat).toBe(AudioSoundFormat.AAC)
    expect(tag.data.equals(aacFrame)).toBe(true)
  })

  it('passes through non-AAC formats as raw payload', () => {
    // soundFormat=G711_U(8), soundRate=0, soundSize=1, soundType=0 → byte0 = 0x82
    const tag = parseFlvAudioTag(hex('82 ff fe fd fc'))
    expect(tag.kind).toBe('audio-raw')
    if (tag.kind !== 'audio-raw') return
    expect(tag.soundFormat).toBe(AudioSoundFormat.G711_U)
    expect(tag.data.equals(hex('ff fe fd fc'))).toBe(true)
  })
})

// ── ADTS sniff + AAC sample-rate lookup ────────────────────────────────

describe('looksLikeAdts', () => {
  it('detects 0xFFF sync word', () => {
    expect(looksLikeAdts(hex('ff f1'))).toBe(true)
    expect(looksLikeAdts(hex('ff f9'))).toBe(true)
    expect(looksLikeAdts(hex('ff e0'))).toBe(false)
    expect(looksLikeAdts(hex('00 00'))).toBe(false)
    expect(looksLikeAdts(hex('ff'))).toBe(false)
  })
})

describe('aacSamplingIndexToHz', () => {
  it('returns the standard table values', () => {
    expect(aacSamplingIndexToHz(3)).toBe(48000)
    expect(aacSamplingIndexToHz(4)).toBe(44100)
    expect(aacSamplingIndexToHz(8)).toBe(16000)
    expect(aacSamplingIndexToHz(11)).toBe(8000)
  })

  it('returns null for reserved indices', () => {
    expect(aacSamplingIndexToHz(13)).toBe(null)
    expect(aacSamplingIndexToHz(14)).toBe(null)
    expect(aacSamplingIndexToHz(15)).toBe(null)
    expect(aacSamplingIndexToHz(99)).toBe(null)
  })
})

// ── AnnexB assembly ────────────────────────────────────────────────────

describe('nalusToAnnexB / buildH264ParamSetsAnnexB / buildH265ParamSetsAnnexB', () => {
  it('joins NAL bodies with 4-byte start codes', () => {
    const out = nalusToAnnexB([SPS_BODY, PPS_BODY])
    const expected = Buffer.concat([hex('00 00 00 01'), SPS_BODY, hex('00 00 00 01'), PPS_BODY])
    expect(out.equals(expected)).toBe(true)
  })

  it('returns empty buffer for empty NALU list', () => {
    expect(nalusToAnnexB([]).length).toBe(0)
  })

  it('builds H.264 SPS+PPS prefix', () => {
    const out = buildH264ParamSetsAnnexB({
      configurationVersion: 1,
      avcProfileIndication: 0x42,
      profileCompatibility: 0,
      avcLevelIndication: 0x1e,
      lengthSizeMinusOne: 3,
      sps: [SPS_BODY],
      pps: [PPS_BODY],
    })
    expect(out.subarray(0, 4).equals(hex('00 00 00 01'))).toBe(true)
    expect(out.includes(SPS_BODY)).toBe(true)
    expect(out.includes(PPS_BODY)).toBe(true)
  })

  it('builds H.265 VPS+SPS+PPS prefix in correct order', () => {
    const out = buildH265ParamSetsAnnexB({
      configurationVersion: 1,
      generalProfileSpace: 0,
      generalTierFlag: 0,
      generalProfileIdc: 1,
      generalProfileCompatibilityFlags: 0,
      generalLevelIdc: 0x78,
      lengthSizeMinusOne: 3,
      vps: [VPS_BODY],
      sps: [HEVC_SPS_BODY],
      pps: [HEVC_PPS_BODY],
    })
    // Expect: [start][VPS][start][SPS][start][PPS]
    const expected = Buffer.concat([
      hex('00 00 00 01'),
      VPS_BODY,
      hex('00 00 00 01'),
      HEVC_SPS_BODY,
      hex('00 00 00 01'),
      HEVC_PPS_BODY,
    ])
    expect(out.equals(expected)).toBe(true)
  })
})

// ── Error path coverage ───────────────────────────────────────────────

describe('parser error paths', () => {
  it('rejects empty video tag', () => {
    expect(() => parseFlvVideoTag(Buffer.alloc(0))).toThrow(FlvParseError)
  })

  it('rejects truncated AVC sequence header', () => {
    // codec=H264, packet=SEQUENCE_HEADER, but only 4 bytes of config (need ≥7)
    expect(() => parseFlvVideoTag(hex('17 00 00 00 00 01 42 00 1e'))).toThrow(FlvParseError)
  })

  it('rejects empty audio tag', () => {
    expect(() => parseFlvAudioTag(Buffer.alloc(0))).toThrow(FlvParseError)
  })
})
