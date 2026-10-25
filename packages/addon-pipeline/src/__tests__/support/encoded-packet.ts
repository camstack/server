import type { EncodedPacket } from '@camstack/types'

/** Minimal video {@link EncodedPacket} for stream-broker specs. */
export function videoPacket(
  patch: Partial<EncodedPacket> & Pick<EncodedPacket, 'data' | 'pts'>,
): EncodedPacket {
  return {
    type: 'video',
    codec: patch.codec ?? 'h264',
    dts: patch.dts ?? patch.pts,
    keyframe: patch.keyframe ?? false,
    ...patch,
  }
}
