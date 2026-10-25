/**
 * The codec the camera really publishes, for the multi-tier service's tier
 * declaration.
 *
 * A tier list names ONE codec for all its tiers, so this has to pick. It picks
 * from the LARGEST stream, because that is the one the high tier will carry and
 * the one whose codec decides whether we transcode. A camera that offers a tiny
 * HEVC substream beside a 1080p H.264 main is an H.264 camera for our purposes.
 *
 * Absence falls back to H.264: it is what every controller accepts and what the
 * classic path already serves, so an unreadable publisher costs us the feature
 * rather than the camera.
 */
import { TierVideoCodec } from './video-stream-tiers.js'

export interface CodecCandidateStream {
  readonly codec?: string | undefined
  readonly resolution?: { readonly width: number; readonly height: number } | undefined
}

/** The spellings publishers in this fleet actually use for HEVC. */
function isHevc(codec: string | undefined): boolean {
  if (codec === undefined) {
    return false
  }
  const normalised = codec.toLowerCase().replace(/[.\-_\s]/g, '')
  return normalised === 'h265' || normalised === 'hevc'
}

/** The stream whose codec and size describe this camera at its best. */
function largestReadableStream(
  streams: readonly CodecCandidateStream[],
): CodecCandidateStream | undefined {
  let best: CodecCandidateStream | undefined
  let bestArea = -1
  for (const stream of streams) {
    if (stream.codec === undefined) {
      continue
    }
    // A stream with no resolution still counts — it just cannot outrank one
    // that has a size, and it wins only when nothing else is readable.
    const area =
      stream.resolution === undefined ? 0 : stream.resolution.width * stream.resolution.height
    if (area > bestArea) {
      bestArea = area
      best = stream
    }
  }
  return best
}

export function nativeCodecForStreams(streams: readonly CodecCandidateStream[]): TierVideoCodec {
  return isHevc(largestReadableStream(streams)?.codec) ? TierVideoCodec.H265 : TierVideoCodec.H264
}

export interface SensorProfile {
  readonly width: number
  readonly height: number
  readonly codec: TierVideoCodec
}

/**
 * The sensor the new camera service describes: size AND codec, from ONE stream.
 *
 * They used to come from two places and the kitchen camera showed what that
 * costs. The codec was read off the published streams -- h265, correct --
 * while the size came from the CLASSIC service's advertised resolution list,
 * which is capped at 1080p because that is the ceiling the classic service
 * accepts. So the accessory advertised "H.265, 1920x1080" for a camera whose
 * main stream is 3840x2160 H.265, and the 4K the new service exists to carry
 * was never offered.
 *
 * One stream answers both questions, so the two cannot disagree again.
 */
export function sensorForStreams(streams: readonly CodecCandidateStream[]): SensorProfile {
  const best = largestReadableStream(streams)
  const resolution = best?.resolution
  return {
    // 1080p is the fallback for the same reason H.264 is: it is what the
    // classic path already serves, so an unreadable publisher costs the
    // feature rather than the camera.
    width: resolution?.width ?? 1920,
    height: resolution?.height ?? 1080,
    codec: isHevc(best?.codec) ? TierVideoCodec.H265 : TierVideoCodec.H264,
  }
}
