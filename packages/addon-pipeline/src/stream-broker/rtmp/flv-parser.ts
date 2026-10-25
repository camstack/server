/**
 * FLV Audio/Video tag payload parser (RTMP messages).
 *
 * Standard FLV (Adobe spec) supports H.264 (codecId=7) and AAC.
 *
 * Enhanced RTMP / Enhanced FLV (Veovera spec, used by YouTube Live and most
 * modern Reolink firmware for HEVC streams) extends the layout:
 *   byte 0:
 *     bit 7      : IsExHeader (1 = enhanced layout follows)
 *     bits 4..6  : PacketType  (0=SequenceStart, 1=CodedFrames, 2=SequenceEnd,
 *                              3=CodedFramesX, 4=Metadata, 5=MPEG2TS-SequenceStart)
 *     bits 0..3  : FrameType   (1=key, 2=inter, ...)
 *   bytes 1..4   : FOURCC ('hvc1' / 'hev1' = H.265, 'av01' = AV1, 'vp09' = VP9)
 *   remainder    : codec/packet-type-specific payload
 *
 * H.265 / enhanced-FLV branches added here.
 */

// ── Standard FLV enums ────────────────────────────────────────────────

export enum VideoCodecId {
  JPEG = 1,
  SORENSON_H263 = 2,
  SCREEN_VIDEO = 3,
  ON2_VP6 = 4,
  ON2_VP6_WITH_ALPHA = 5,
  SCREEN_VIDEO_V2 = 6,
  H264 = 7,
  /**
   * Non-standard codecId for HEVC, predating the Veovera Enhanced-FLV
   * spec. Used by Reolink RLC-810/820/etc., ZLMediaKit, ffmpeg builds
   * with HEVC FLV patches, and MediaMTX. Layout matches codecId=7
   * (H.264) — the only difference is that SEQUENCE_HEADER carries
   * HEVCDecoderConfigurationRecord and NALU payloads contain HEVC NAL
   * units.
   */
  H265_LEGACY = 12,
}

export enum VideoFrameType {
  KEY = 1,
  INTER = 2,
  DISPOSABLE_INTER = 3,
  GENERATED_KEYFRAME = 4,
  VIDEO_INFO = 5,
}

export enum AvcPacketType {
  SEQUENCE_HEADER = 0,
  NALU = 1,
  END_OF_SEQUENCE = 2,
}

export enum AudioSoundFormat {
  PCM_BE = 0,
  ADPCM = 1,
  MP3 = 2,
  PCM_LE = 3,
  NELLYMOSER_16K = 4,
  NELLYMOSER_8K = 5,
  NELLYMOSER = 6,
  G711_A = 7,
  G711_U = 8,
  AAC = 10,
  SPEEX = 11,
  MP3_8K = 14,
}

export enum AacPacketType {
  SEQUENCE_HEADER = 0,
  RAW = 1,
}

// ── Enhanced FLV (Veovera) ────────────────────────────────────────────

export enum EnhancedPacketType {
  SEQUENCE_START = 0,
  CODED_FRAMES = 1,
  SEQUENCE_END = 2,
  CODED_FRAMES_X = 3,
  METADATA = 4,
  MPEG2TS_SEQUENCE_START = 5,
}

/** Canonical codec discriminator for the parsed video tag. */
export type VideoCodec = 'h264' | 'h265'

// ── Decoder configuration record types ────────────────────────────────

export interface AvcDecoderConfigurationRecord {
  readonly configurationVersion: number
  readonly avcProfileIndication: number
  readonly profileCompatibility: number
  readonly avcLevelIndication: number
  /** NALU length-size = lengthSizeMinusOne + 1 (1, 2, or 4) */
  readonly lengthSizeMinusOne: number
  readonly sps: ReadonlyArray<Buffer>
  readonly pps: ReadonlyArray<Buffer>
}

export interface HevcDecoderConfigurationRecord {
  readonly configurationVersion: number
  readonly generalProfileSpace: number
  readonly generalTierFlag: number
  readonly generalProfileIdc: number
  readonly generalProfileCompatibilityFlags: number
  readonly generalLevelIdc: number
  /** NALU length-size = lengthSizeMinusOne + 1 (1, 2, or 4) */
  readonly lengthSizeMinusOne: number
  readonly vps: ReadonlyArray<Buffer>
  readonly sps: ReadonlyArray<Buffer>
  readonly pps: ReadonlyArray<Buffer>
}

// ── Audio decoder configuration ───────────────────────────────────────

export interface AudioSpecificConfig {
  readonly audioObjectType: number
  readonly samplingFrequencyIndex: number
  readonly channelConfiguration: number
}

// ── Parsed tag types ──────────────────────────────────────────────────

interface FlvVideoTagBase {
  readonly frameType: VideoFrameType
  readonly codec: VideoCodec
  /** Composition-time offset in milliseconds (0 for enhanced FLV CODED_FRAMES_X). */
  readonly compositionTime: number
}

export interface FlvVideoSequenceHeaderH264 extends FlvVideoTagBase {
  readonly kind: 'video-sequence-header'
  readonly codec: 'h264'
  readonly avcConfig: AvcDecoderConfigurationRecord
}

export interface FlvVideoSequenceHeaderH265 extends FlvVideoTagBase {
  readonly kind: 'video-sequence-header'
  readonly codec: 'h265'
  readonly hevcConfig: HevcDecoderConfigurationRecord
}

export interface FlvVideoCodedFrames extends FlvVideoTagBase {
  readonly kind: 'video-coded-frames'
  readonly nalus: ReadonlyArray<Buffer>
}

export interface FlvVideoSequenceEnd extends FlvVideoTagBase {
  readonly kind: 'video-sequence-end'
}

export type FlvVideoTag =
  | FlvVideoSequenceHeaderH264
  | FlvVideoSequenceHeaderH265
  | FlvVideoCodedFrames
  | FlvVideoSequenceEnd

export interface FlvAudioSequenceHeader {
  readonly kind: 'audio-sequence-header'
  readonly soundFormat: AudioSoundFormat
  readonly audioSpecificConfig: AudioSpecificConfig
  /** Raw 2-byte AudioSpecificConfig — useful for SDP / pushAudioInfo. */
  readonly audioSpecificConfigBytes: Buffer
}

export interface FlvAudioRaw {
  readonly kind: 'audio-raw'
  readonly soundFormat: AudioSoundFormat
  readonly data: Buffer
}

export type FlvAudioTag = FlvAudioSequenceHeader | FlvAudioRaw

// ── Errors ────────────────────────────────────────────────────────────

export class FlvParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlvParseError'
  }
}

export class UnsupportedCodecError extends FlvParseError {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedCodecError'
  }
}

// ── Configuration record parsers ──────────────────────────────────────

function parseAvcDecoderConfigurationRecord(buffer: Buffer): AvcDecoderConfigurationRecord {
  if (buffer.length < 7) {
    throw new FlvParseError('AVCDecoderConfigurationRecord too short')
  }

  const configurationVersion = buffer.readUInt8(0)
  const avcProfileIndication = buffer.readUInt8(1)
  const profileCompatibility = buffer.readUInt8(2)
  const avcLevelIndication = buffer.readUInt8(3)
  const lengthSizeMinusOne = buffer.readUInt8(4) & 0x03

  const numSPS = buffer.readUInt8(5) & 0x1f
  let pos = 6

  const sps: Buffer[] = []
  for (let i = 0; i < numSPS; i++) {
    if (pos + 2 > buffer.length)
      throw new FlvParseError('AVCDecoderConfigurationRecord truncated reading SPS length')
    const len = buffer.readUInt16BE(pos)
    pos += 2
    if (pos + len > buffer.length)
      throw new FlvParseError('AVCDecoderConfigurationRecord SPS exceeds buffer')
    sps.push(buffer.subarray(pos, pos + len))
    pos += len
  }

  const pps: Buffer[] = []
  if (pos < buffer.length) {
    const numPPS = buffer.readUInt8(pos)
    pos += 1
    for (let i = 0; i < numPPS; i++) {
      if (pos + 2 > buffer.length)
        throw new FlvParseError('AVCDecoderConfigurationRecord truncated reading PPS length')
      const len = buffer.readUInt16BE(pos)
      pos += 2
      if (pos + len > buffer.length)
        throw new FlvParseError('AVCDecoderConfigurationRecord PPS exceeds buffer')
      pps.push(buffer.subarray(pos, pos + len))
      pos += len
    }
  }

  return {
    configurationVersion,
    avcProfileIndication,
    profileCompatibility,
    avcLevelIndication,
    lengthSizeMinusOne,
    sps,
    pps,
  }
}

/**
 * Parse HEVCDecoderConfigurationRecord (HVCC) per ISO/IEC 14496-15 §8.
 * Layout (relevant fields only — reserved bits skipped):
 *
 *   u8  configurationVersion       (= 1)
 *   u8  general_profile_space(2) | general_tier_flag(1) | general_profile_idc(5)
 *   u32 general_profile_compatibility_flags
 *   u48 general_constraint_indicator_flags
 *   u8  general_level_idc
 *   u16 reserved(4) | min_spatial_segmentation_idc(12)
 *   u8  reserved(6) | parallelismType(2)
 *   u8  reserved(6) | chromaFormat(2)
 *   u8  reserved(5) | bitDepthLumaMinus8(3)
 *   u8  reserved(5) | bitDepthChromaMinus8(3)
 *   u16 avgFrameRate
 *   u8  constantFrameRate(2) | numTemporalLayers(3) | temporalIdNested(1) | lengthSizeMinusOne(2)
 *   u8  numOfArrays
 *   for each array:
 *     u8  array_completeness(1) | reserved(1) | NAL_unit_type(6)
 *     u16 numNalus
 *     for each nalu: u16 nalUnitLength, then nalUnit bytes
 *
 * The fixed-size header is exactly 22 bytes; arrays start at offset 22.
 * NAL unit types of interest: 32 = VPS, 33 = SPS, 34 = PPS.
 */
function parseHevcDecoderConfigurationRecord(buffer: Buffer): HevcDecoderConfigurationRecord {
  if (buffer.length < 23) {
    throw new FlvParseError('HEVCDecoderConfigurationRecord too short')
  }

  const configurationVersion = buffer.readUInt8(0)
  const byte1 = buffer.readUInt8(1)
  const generalProfileSpace = (byte1 >> 6) & 0x03
  const generalTierFlag = (byte1 >> 5) & 0x01
  const generalProfileIdc = byte1 & 0x1f
  const generalProfileCompatibilityFlags = buffer.readUInt32BE(2)
  // bytes 6..11 = general_constraint_indicator_flags (48 bits) — preserved but not exposed
  const generalLevelIdc = buffer.readUInt8(12)
  // bytes 13..14 = min_spatial_segmentation_idc (low 12 bits)
  // byte 15      = parallelismType
  // byte 16      = chromaFormat
  // byte 17      = bitDepthLumaMinus8
  // byte 18      = bitDepthChromaMinus8
  // bytes 19..20 = avgFrameRate
  // byte 21      = constantFrameRate(2) | numTemporalLayers(3) | temporalIdNested(1) | lengthSizeMinusOne(2)
  const lengthSizeMinusOne = buffer.readUInt8(21) & 0x03

  const numOfArrays = buffer.readUInt8(22)
  let pos = 23

  const vps: Buffer[] = []
  const sps: Buffer[] = []
  const pps: Buffer[] = []

  for (let a = 0; a < numOfArrays; a++) {
    if (pos + 3 > buffer.length)
      throw new FlvParseError('HEVCDecoderConfigurationRecord truncated reading array header')
    const nalUnitType = buffer.readUInt8(pos) & 0x3f
    const numNalus = buffer.readUInt16BE(pos + 1)
    pos += 3

    for (let n = 0; n < numNalus; n++) {
      if (pos + 2 > buffer.length)
        throw new FlvParseError('HEVCDecoderConfigurationRecord truncated reading NALU length')
      const len = buffer.readUInt16BE(pos)
      pos += 2
      if (pos + len > buffer.length)
        throw new FlvParseError('HEVCDecoderConfigurationRecord NALU exceeds buffer')
      const nal = buffer.subarray(pos, pos + len)
      pos += len

      if (nalUnitType === 32) vps.push(nal)
      else if (nalUnitType === 33) sps.push(nal)
      else if (nalUnitType === 34) pps.push(nal)
      // SEI / other NAL arrays are dropped — not needed for decoder init.
    }
  }

  return {
    configurationVersion,
    generalProfileSpace,
    generalTierFlag,
    generalProfileIdc,
    generalProfileCompatibilityFlags,
    generalLevelIdc,
    lengthSizeMinusOne,
    vps,
    sps,
    pps,
  }
}

function parseAudioSpecificConfig(buffer: Buffer): AudioSpecificConfig {
  if (buffer.length < 2) throw new FlvParseError('AudioSpecificConfig too short')
  const b0 = buffer.readUInt8(0)
  const b1 = buffer.readUInt8(1)
  return {
    audioObjectType: (b0 >> 3) & 0x1f,
    samplingFrequencyIndex: ((b0 & 0x07) << 1) | ((b1 >> 7) & 0x01),
    channelConfiguration: (b1 >> 3) & 0x0f,
  }
}

// ── NALU extraction (length-prefixed → list of NAL bodies) ────────────

function extractLengthPrefixedNalus(payload: Buffer, lengthSize: number): Buffer[] {
  if (lengthSize < 1 || lengthSize > 4) {
    throw new FlvParseError(`Invalid NALU length-size: ${lengthSize}`)
  }
  const out: Buffer[] = []
  let pos = 0
  while (pos + lengthSize <= payload.length) {
    const len = payload.readUIntBE(pos, lengthSize)
    pos += lengthSize
    if (len === 0) continue
    if (pos + len > payload.length) {
      throw new FlvParseError(`NALU exceeds payload at pos=${pos} len=${len}`)
    }
    out.push(payload.subarray(pos, pos + len))
    pos += len
  }
  return out
}

// ── AAC ADTS sniffing (audio path runtime helper) ─────────────────────

const ADTS_SYNC_WORD = 0xfff

/**
 * Returns true when `buffer` starts with the 12-bit AAC ADTS sync word
 * (0xFFF). Used by the RTMP reader to disambiguate AAC raw frames coming
 * directly from cameras that bypass the AAC sequence header step.
 */
export function looksLikeAdts(buffer: Buffer): boolean {
  if (buffer.length < 2) return false
  return ((buffer.readUInt8(0) << 4) | (buffer.readUInt8(1) >> 4)) === ADTS_SYNC_WORD
}

// ── Public entry points ───────────────────────────────────────────────

/**
 * Parse an RTMP video tag (FLV message-type 9) payload.
 *
 * Throws `UnsupportedCodecError` for codecs we cannot route to AnnexB
 * downstream (anything other than H.264 / H.265).
 */
export function parseFlvVideoTag(buffer: Buffer): FlvVideoTag {
  if (buffer.length < 1) throw new FlvParseError('Video tag empty')
  const byte0 = buffer.readUInt8(0)
  const isExHeader = (byte0 & 0x80) !== 0

  if (isExHeader) {
    return parseEnhancedVideoTag(buffer)
  }

  // Standard FLV layout (codecId=7 H.264, or codecId=12 H.265-legacy)
  const frameType = (byte0 >> 4) as VideoFrameType
  const codecId = byte0 & 0x0f

  const codec: VideoCodec | null =
    codecId === VideoCodecId.H264 ? 'h264' : codecId === VideoCodecId.H265_LEGACY ? 'h265' : null
  if (codec === null) {
    throw new UnsupportedCodecError(
      `FLV video codecId=${codecId} not supported (only H.264 / H.265-legacy / H.265-enhanced)`,
    )
  }

  return parseStandardLayoutVideoTag(buffer, codec, frameType, 4)
}

/**
 * Shared parser for the codecId=7 (H.264) / codecId=12 (H.265 legacy)
 * layout: byte0 frameType+codecId, byte1 packetType, bytes2..4 composition
 * time offset (signed), then payload (decoder config or length-prefixed
 * NALUs).
 */
function parseStandardLayoutVideoTag(
  buffer: Buffer,
  codec: VideoCodec,
  frameType: VideoFrameType,
  lengthSize: number,
): FlvVideoTag {
  if (buffer.length < 5)
    throw new FlvParseError(`${codec.toUpperCase()} video tag header truncated`)
  const packetType = buffer.readUInt8(1) as AvcPacketType
  const compositionTime = buffer.readIntBE(2, 3)

  if (packetType === AvcPacketType.SEQUENCE_HEADER) {
    if (codec === 'h264') {
      const avcConfig = parseAvcDecoderConfigurationRecord(buffer.subarray(5))
      return { kind: 'video-sequence-header', codec: 'h264', frameType, compositionTime, avcConfig }
    }
    const hevcConfig = parseHevcDecoderConfigurationRecord(buffer.subarray(5))
    return { kind: 'video-sequence-header', codec: 'h265', frameType, compositionTime, hevcConfig }
  }

  if (packetType === AvcPacketType.NALU) {
    const nalus = extractLengthPrefixedNalus(buffer.subarray(5), lengthSize)
    return { kind: 'video-coded-frames', codec, frameType, compositionTime, nalus }
  }

  if (packetType === AvcPacketType.END_OF_SEQUENCE) {
    return { kind: 'video-sequence-end', codec, frameType, compositionTime }
  }

  throw new FlvParseError(`Unknown AVC packet type: ${packetType}`)
}

/**
 * Same as `parseFlvVideoTag` but uses the supplied NALU length-size
 * when extracting CodedFrames payloads. Callers that have parsed a
 * prior SequenceHeader should prefer this overload for correctness on
 * cameras that ship a non-default `lengthSizeMinusOne`.
 */
export function parseFlvVideoTagWithLengthSize(buffer: Buffer, lengthSize: number): FlvVideoTag {
  if (buffer.length < 1) throw new FlvParseError('Video tag empty')
  const byte0 = buffer.readUInt8(0)
  const isExHeader = (byte0 & 0x80) !== 0

  if (isExHeader) {
    return parseEnhancedVideoTag(buffer, lengthSize)
  }

  const frameType = (byte0 >> 4) as VideoFrameType
  const codecId = byte0 & 0x0f
  const codec: VideoCodec | null =
    codecId === VideoCodecId.H264 ? 'h264' : codecId === VideoCodecId.H265_LEGACY ? 'h265' : null
  if (codec === null) {
    throw new UnsupportedCodecError(`FLV video codecId=${codecId} not supported`)
  }
  return parseStandardLayoutVideoTag(buffer, codec, frameType, lengthSize)
}

function parseEnhancedVideoTag(buffer: Buffer, lengthSize: number = 4): FlvVideoTag {
  // byte 0 layout: bit7 IsExHeader | bits4..6 PacketType | bits0..3 FrameType
  if (buffer.length < 5) throw new FlvParseError('Enhanced FLV video tag truncated (need FOURCC)')
  const byte0 = buffer.readUInt8(0)
  const packetType = ((byte0 >> 4) & 0x07) as EnhancedPacketType
  const frameType = (byte0 & 0x0f) as VideoFrameType

  const fourcc = buffer.subarray(1, 5).toString('ascii')
  const codec = mapFourCcToCodec(fourcc)

  if (codec !== 'h265') {
    throw new UnsupportedCodecError(
      `Enhanced FLV FOURCC '${fourcc}' not supported (only hvc1/hev1)`,
    )
  }

  if (packetType === EnhancedPacketType.SEQUENCE_START) {
    const hevcConfig = parseHevcDecoderConfigurationRecord(buffer.subarray(5))
    return {
      kind: 'video-sequence-header',
      codec: 'h265',
      frameType,
      compositionTime: 0,
      hevcConfig,
    }
  }

  if (packetType === EnhancedPacketType.CODED_FRAMES) {
    if (buffer.length < 8) throw new FlvParseError('Enhanced FLV CODED_FRAMES truncated')
    const compositionTime = buffer.readIntBE(5, 3)
    const nalus = extractLengthPrefixedNalus(buffer.subarray(8), lengthSize)
    return { kind: 'video-coded-frames', codec: 'h265', frameType, compositionTime, nalus }
  }

  if (packetType === EnhancedPacketType.CODED_FRAMES_X) {
    const nalus = extractLengthPrefixedNalus(buffer.subarray(5), lengthSize)
    return { kind: 'video-coded-frames', codec: 'h265', frameType, compositionTime: 0, nalus }
  }

  if (packetType === EnhancedPacketType.SEQUENCE_END) {
    return { kind: 'video-sequence-end', codec: 'h265', frameType, compositionTime: 0 }
  }

  throw new FlvParseError(`Unsupported enhanced FLV packet type: ${packetType}`)
}

function mapFourCcToCodec(fourcc: string): VideoCodec | null {
  if (fourcc === 'hvc1' || fourcc === 'hev1') return 'h265'
  if (fourcc === 'avc1') return 'h264'
  return null
}

/** Parse an RTMP audio tag (FLV message-type 8) payload. */
export function parseFlvAudioTag(buffer: Buffer): FlvAudioTag {
  if (buffer.length < 1) throw new FlvParseError('Audio tag empty')
  const byte0 = buffer.readUInt8(0)
  const soundFormat = ((byte0 >> 4) & 0x0f) as AudioSoundFormat

  if (soundFormat !== AudioSoundFormat.AAC) {
    return { kind: 'audio-raw', soundFormat, data: buffer.subarray(1) }
  }

  if (buffer.length < 2) throw new FlvParseError('AAC audio tag truncated')
  const aacPacketType = buffer.readUInt8(1) as AacPacketType

  if (aacPacketType === AacPacketType.SEQUENCE_HEADER) {
    const ascBytes = buffer.subarray(2)
    const audioSpecificConfig = parseAudioSpecificConfig(ascBytes)
    return {
      kind: 'audio-sequence-header',
      soundFormat,
      audioSpecificConfig,
      audioSpecificConfigBytes: Buffer.from(ascBytes),
    }
  }

  return {
    kind: 'audio-raw',
    soundFormat,
    data: buffer.subarray(2),
  }
}

// ── AnnexB assembly helper ────────────────────────────────────────────

/** 4-byte AnnexB start code. */
const ANNEXB_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

/**
 * Assemble a sequence of NAL unit bodies into a single AnnexB buffer.
 * Each NAL is prefixed with `00 00 00 01`.
 */
export function nalusToAnnexB(nalus: ReadonlyArray<Buffer>): Buffer {
  if (nalus.length === 0) return Buffer.alloc(0)
  const parts: Buffer[] = []
  for (const nal of nalus) {
    parts.push(ANNEXB_START_CODE, nal)
  }
  return Buffer.concat(parts)
}

/**
 * Build the AnnexB parameter-set prefix for an H.264 IDR — concatenates
 * SPS + PPS NAL bodies with start codes.
 */
export function buildH264ParamSetsAnnexB(record: AvcDecoderConfigurationRecord): Buffer {
  return nalusToAnnexB([...record.sps, ...record.pps])
}

/**
 * Build the AnnexB parameter-set prefix for an H.265 IDR — concatenates
 * VPS + SPS + PPS NAL bodies with start codes.
 */
export function buildH265ParamSetsAnnexB(record: HevcDecoderConfigurationRecord): Buffer {
  return nalusToAnnexB([...record.vps, ...record.sps, ...record.pps])
}

// ── Frequency-index → sample-rate (AAC) ───────────────────────────────

const AAC_SAMPLE_RATES: ReadonlyArray<number> = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

/**
 * Resolve the sample-rate for an AAC `samplingFrequencyIndex`. Returns
 * `null` for the reserved indices 13–15 so the caller can decide whether
 * to fall back or reject the stream.
 */
export function aacSamplingIndexToHz(index: number): number | null {
  return AAC_SAMPLE_RATES[index] ?? null
}
