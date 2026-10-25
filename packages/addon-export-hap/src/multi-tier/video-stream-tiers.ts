/**
 * The `Supported Video Stream Tiers` TLV8 — the characteristic through which an
 * accessory offers HEVC and 4K to HomeKit.
 *
 * ## Where this comes from
 *
 * Apple's *HomeKit Secure Video Open Source Compatibility Guide* (Developer
 * Preview, 2026-06-03). It defines TWO new streaming services beside the one
 * this addon uses today:
 *
 *  - `camera-multi-tier-rtp-stream-management` (0x8031) — still RTP, which is
 *    the plumbing we already have, and the reason this file exists at all.
 *  - `camera-webrtc-stream-management` (0x8033) — a different transport.
 *
 * Both advertise their capability with this TLV. Recording moves separately to
 * CMAF ingest (0x8000 + a client-certificate provisioning flow at 0x8080), and
 * is NOT in scope here: the certificate dance belongs to ingest, not to live
 * streaming, which is what makes the live path the tractable half.
 *
 * ## Why we write this ourselves rather than patching the library
 *
 * `@homebridge/hap-nodejs@2.1.7` models none of it — its `VideoCodecType` has
 * one member, `H264 = 0`, and the new specification numbers H.264 as **1**. It
 * is not the same enumeration, so there is nothing here to extend. But nothing
 * needs patching either: `Service` and `Characteristic` take arbitrary UUIDs,
 * `Accessory.addService` validates only for duplicates and a count, and the
 * `Controller` interface is public. So this is an EXTENSION, not a fork —
 * nothing to rebase when the library moves.
 *
 * Pure bytes in, pure bytes out. No accessory, no service, no I/O: the wire
 * format is the part a test can hold still.
 */
import { encode } from '@homebridge/hap-nodejs'

/** Video codec, as the NEW specification numbers it. Deliberately not the
 *  library's `VideoCodecType`, whose `H264` is `0`. */
export enum TierVideoCodec {
  H264 = 1,
  H265 = 2,
}

/**
 * Quality tier.
 *
 * `HIGHEST` is not "even better than HIGH": the guide reserves it for the 4K
 * stream of a camera that offers a 2K stream AT THE SAME TIME, and says a
 * camera that cannot do both should not use the value. Encoding it without that
 * capability advertises a camera we do not have.
 */
export enum TierQuality {
  HIGHEST = 1,
  HIGH = 2,
  MEDIUM = 3,
  LOW = 4,
}

/** TLV types inside one tier. */
enum TierTlv {
  IDENTIFIER = 0x01,
  QUALITY = 0x02,
  TARGET_AVERAGE_BITRATE = 0x03,
  WIDTH = 0x04,
  HEIGHT = 0x05,
  FRAME_RATE = 0x06,
}

/** TLV types of the characteristic itself. */
enum ConfigTlv {
  CODEC = 0x01,
  PAYLOAD_TYPE = 0x02,
  TIERS = 0x03,
}

export interface VideoStreamTier {
  /** Identifier for this tier — the value a controller names when selecting. */
  readonly identifier: number
  readonly quality: TierQuality
  /** Target AVERAGE bitrate, in kbps. The guide's targets: 4K@24/30 → 4500,
   *  2K → 2800, 1080p30 → 1700, 720p30 → 768, 360p/240p → 180. */
  readonly targetAverageBitrateKbps: number
  readonly width: number
  readonly height: number
  readonly frameRate: number
}

export interface VideoStreamConfiguration {
  readonly codec: TierVideoCodec
  /** RTP payload type, per RFC 3551. */
  readonly payloadType: number
  readonly tiers: readonly VideoStreamTier[]
}

function uint8(value: number): Buffer {
  const b = Buffer.alloc(1)
  b.writeUInt8(value, 0)
  return b
}

function uint16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value, 0)
  return b
}

function uint32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value, 0)
  return b
}

/** One tier, as its own TLV8 blob. */
export function encodeVideoStreamTier(tier: VideoStreamTier): Buffer {
  return encode(
    TierTlv.IDENTIFIER,
    uint32(tier.identifier),
    TierTlv.QUALITY,
    uint8(tier.quality),
    TierTlv.TARGET_AVERAGE_BITRATE,
    uint32(tier.targetAverageBitrateKbps),
    TierTlv.WIDTH,
    uint16(tier.width),
    TierTlv.HEIGHT,
    uint16(tier.height),
    TierTlv.FRAME_RATE,
    uint8(tier.frameRate),
  )
}

/**
 * The whole characteristic value.
 *
 * The tier list is REPEATED — one TLV of type 3 per tier — and repetition is
 * how HAP carries a list. Emitting one blob with the tiers concatenated inside
 * would decode as a single unreadable tier.
 */
export function encodeVideoStreamConfiguration(config: VideoStreamConfiguration): Buffer {
  // An ARRAY as the data emits one TLV of that type per element — the
  // library's own way of writing a repeated field, and the reason this does not
  // hand-roll the loop. Concatenating the tiers into a single blob would decode
  // as one unreadable tier.
  return encode(
    ConfigTlv.CODEC,
    uint8(config.codec),
    ConfigTlv.PAYLOAD_TYPE,
    uint8(config.payloadType),
    ConfigTlv.TIERS,
    config.tiers.map(encodeVideoStreamTier),
  )
}
