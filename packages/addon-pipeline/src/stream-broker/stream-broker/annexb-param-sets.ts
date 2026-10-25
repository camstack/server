/**
 * Annex-B parameter-set detection for the clip-priming path.
 *
 * A decoder of a pre-buffer clip (`prebuffer-clip.ts`) initialises only once it
 * sees the codec parameter sets (H.264 SPS+PPS / H.265 SPS+PPS, plus VPS) in
 * its Annex-B input. Most cameras carry them in-band with each IDR; some
 * (Reolink high-profile native streams) ship them ONLY in the SDP. The broker
 * harvests those SDP param sets (`sdpParameterSets`) but must not blindly
 * re-inject them ahead of every keyframe — that would duplicate the sets for
 * well-behaved cameras. This scan lets the clip writer inject only when a
 * keyframe's own NAL stream is missing them.
 *
 * Pure byte scanning: no allocation beyond the walk; safe on any Annex-B blob.
 */

/** Required parameter-set NAL types per codec (SPS, PPS). */
const H264_SPS = 7
const H264_PPS = 8
const H265_SPS = 33
const H265_PPS = 34

function isH265Codec(codec: string): boolean {
  const c = codec.toLowerCase()
  return c.includes('265') || c.includes('hevc')
}

/**
 * True when `data` already carries BOTH the SPS and the PPS the decoder needs
 * to initialise (per `codec`). Walks Annex-B NAL units by their 3- or 4-byte
 * start codes and reads each NAL header type. Returns as soon as both are seen.
 */
export function annexBHasParameterSets(data: Buffer, codec: string): boolean {
  const h265 = isH265Codec(codec)
  const spsType = h265 ? H265_SPS : H264_SPS
  const ppsType = h265 ? H265_PPS : H264_PPS
  let hasSps = false
  let hasPps = false

  const len = data.length
  let i = 0
  while (i + 3 < len) {
    // Match a start code: 00 00 01 (3-byte) or 00 00 00 01 (4-byte).
    if (data[i] === 0x00 && data[i + 1] === 0x00) {
      let nalStart = -1
      if (data[i + 2] === 0x01) nalStart = i + 3
      else if (data[i + 2] === 0x00 && data[i + 3] === 0x01) nalStart = i + 4
      if (nalStart >= 0 && nalStart < len) {
        const headerByte = data[nalStart]!
        const nalType = h265 ? (headerByte >> 1) & 0x3f : headerByte & 0x1f
        if (nalType === spsType) hasSps = true
        else if (nalType === ppsType) hasPps = true
        if (hasSps && hasPps) return true
        i = nalStart + 1
        continue
      }
    }
    i += 1
  }
  return hasSps && hasPps
}
