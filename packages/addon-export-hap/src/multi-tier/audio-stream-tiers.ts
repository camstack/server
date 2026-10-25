/**
 * The `Supported Audio Stream Tiers` TLV8 — 0x8044, a REQUIRED characteristic
 * of `camera-multi-tier-rtp-stream-management`.
 *
 * ## Not the WebRTC one
 *
 * The WebRTC service has its own audio characteristic at 0x805A, and the two
 * are easy to confuse because they carry the same idea. This file is the RTP
 * one. A service that declares the wrong sibling is a service the controller
 * reads and abandons without saying why.
 *
 * ## What the revision fixes, and why that is encoded as a refusal
 *
 * Three of the six fields are not choices in this revision of the guide:
 * packet time is 20 ms, channels is 1, and **exactly one tier is allowed**.
 * The tier count is the one that cannot be expressed in a type, so it is
 * checked — a second tier would be silently dropped by a controller, or worse,
 * accepted and then used to select a stream we never meant to offer.
 *
 * Pure bytes in, pure bytes out, like its video sibling.
 */
import { encode } from '@homebridge/hap-nodejs'

/** Audio codec. Opus is the only value this revision defines, and the guide
 *  requires the accessory to support it. */
export enum TierAudioCodec {
  OPUS = 3,
}

/**
 * Sample rate, as REPORTED on the wire.
 *
 * With Opus the transmission rate is always 48 kHz whatever the capture rate
 * is, and the guide says the characteristic carries the transmission rate. A
 * camera capturing at 16 kHz still reports 48.
 */
export enum AudioSampleRate {
  RATE_16_KHZ = 1,
  RATE_24_KHZ = 2,
  RATE_32_KHZ = 3,
  RATE_48_KHZ = 4,
}

export enum AudioTierBitDepth {
  BITS_8 = 1,
  BITS_16 = 2,
  BITS_24 = 3,
}

/** TLV types inside one tier. */
enum AudioTierTlv {
  IDENTIFIER = 0x01,
  TARGET_AVERAGE_BITRATE = 0x02,
  SAMPLE_RATE = 0x03,
  BIT_DEPTH = 0x04,
  PACKET_TIME = 0x05,
  CHANNELS = 0x06,
}

/** TLV types of the characteristic itself. */
enum AudioConfigTlv {
  CODEC = 0x01,
  PAYLOAD_TYPE = 0x02,
  TIERS = 0x03,
}

export interface AudioStreamTier {
  readonly identifier: number
  /** Target average bitrate in BITS per second — note the unit differs from
   *  the video tier, which is in kbps. The guide spells both out. */
  readonly targetAverageBitrateBps: number
  readonly sampleRate: AudioSampleRate
  readonly bitDepth: AudioTierBitDepth
  /** 20 is the only value this revision allows. */
  readonly packetTimeMs: number
  /** 1 is the only value this revision allows. */
  readonly channels: number
}

export interface AudioStreamConfiguration {
  readonly codec: TierAudioCodec
  readonly payloadType: number
  readonly tiers: readonly AudioStreamTier[]
}

function uint8(value: number): Buffer {
  const b = Buffer.alloc(1)
  b.writeUInt8(value, 0)
  return b
}

function uint32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value, 0)
  return b
}

/**
 * The one Opus tier we offer, from the rate the camera actually captures at.
 *
 * The capture rate is an input only so that the caller cannot forget it exists;
 * what goes on the wire is 48 kHz either way. Returning a tier rather than
 * bytes keeps the "what do we offer" decision separate from the encoding.
 */
export function opusTierForCapture(captureSampleRateHz: number): AudioStreamTier {
  return {
    identifier: 1,
    // 24 kbps mono Opus is transparent for speech at either capture rate and
    // sits far under every video tier's budget.
    targetAverageBitrateBps: captureSampleRateHz >= 24000 ? 32000 : 24000,
    sampleRate: AudioSampleRate.RATE_48_KHZ,
    bitDepth: AudioTierBitDepth.BITS_16,
    packetTimeMs: 20,
    channels: 1,
  }
}

export function encodeAudioStreamTier(tier: AudioStreamTier): Buffer {
  return encode(
    AudioTierTlv.IDENTIFIER,
    uint32(tier.identifier),
    AudioTierTlv.TARGET_AVERAGE_BITRATE,
    uint32(tier.targetAverageBitrateBps),
    AudioTierTlv.SAMPLE_RATE,
    uint8(tier.sampleRate),
    AudioTierTlv.BIT_DEPTH,
    uint8(tier.bitDepth),
    AudioTierTlv.PACKET_TIME,
    uint8(tier.packetTimeMs),
    AudioTierTlv.CHANNELS,
    uint8(tier.channels),
  )
}

export function encodeAudioStreamConfiguration(config: AudioStreamConfiguration): Buffer {
  if (config.tiers.length !== 1) {
    throw new Error(
      `supported-audio-stream-tiers allows exactly one tier in this revision, got ${config.tiers.length}`,
    )
  }
  return encode(
    AudioConfigTlv.CODEC,
    uint8(config.codec),
    AudioConfigTlv.PAYLOAD_TYPE,
    uint8(config.payloadType),
    AudioConfigTlv.TIERS,
    config.tiers.map(encodeAudioStreamTier),
  )
}
