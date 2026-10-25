/**
 * segment-demux — turn one self-contained `.m4s` fragment (a Buffer) into
 * ordered Annex-B access units. Codec-agnostic: handles BOTH H.264 and H.265
 * recordings (the recorder is `-c:v copy` passthrough, so an H.264 camera
 * produces H.264 recordings and an H.265 camera produces H.265 recordings).
 *
 * The recorder writes self-contained fragments: each `.m4s` carries its own
 * `moov` (and thus its own `avcC`/`hvcC` parameter sets) plus exactly one
 * IDR-led GOP (~4s). To replay one over a push pipeline we need the bytes as
 * Annex-B access units with parameter sets prepended to every IDR (SPS/PPS for
 * H.264; VPS/SPS/PPS for H.265) and each unit tagged with its source PTS.
 *
 * Implementation: run the fragment through `ffmpeg -c:v copy -f mpegts` (a
 * crash-isolated subprocess — this replaced the old in-process `node-av`
 * demux + `h264/hevc_mp4toannexb` BSF, which could SIGBUS the whole broker on
 * a fragile stream), then split the transport stream back into access units
 * with {@link demuxMpegTsToAnnexB}. The mpegts muxer fuses the parameter sets
 * onto every IDR exactly like the mp4toannexb BSF did, preserves the per-frame
 * PTS (PES 90 kHz), and exposes the codec via the PMT `stream_type` — so no
 * explicit bitstream filter and no separate probe pass are needed. See
 * `ts-annexb-demux.ts` for the container-choice rationale.
 */
import { runFfmpegOnce } from './ffmpeg-run-once.js'
import { demuxMpegTsToAnnexB } from './ts-annexb-demux.js'

/** A single Annex-B access unit demuxed from a recording segment. */
export interface AccessUnit {
  /**
   * Annex-B bytes; parameter sets prepended to IDRs by the mpegts muxer
   * (SPS/PPS for H.264, VPS/SPS/PPS for H.265).
   */
  readonly data: Uint8Array
  /** Source presentation time in milliseconds (segment-relative). */
  readonly ptsMs: number
  /** Whether this access unit is a keyframe (IDR-led GOP start). */
  readonly keyframe: boolean
  /**
   * Video codec of this access unit, detected from the transport stream's PMT
   * `stream_type`. Same value for every AU in one segment. Drives downstream
   * RTP packetization (H.264 FU-A vs H.265 FU) and SDP codec tagging.
   */
  readonly codec: 'H264' | 'H265'
}

/**
 * ffmpeg arguments to remux one `.m4s` fragment (read from stdin) into an
 * Annex-B MPEG-TS on stdout. `-c:v copy` = no re-encode; the mpegts muxer does
 * the mp4→annexb conversion and fuses parameter sets onto every IDR. `-an`
 * drops audio (handled separately by `segment-audio`). Exported for the spec.
 */
export const SEGMENT_DEMUX_FFMPEG_ARGS: readonly string[] = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  'pipe:0',
  '-map',
  '0:v:0',
  '-c:v',
  'copy',
  '-an',
  '-f',
  'mpegts',
  'pipe:1',
]

/**
 * Demux a self-contained H.264 or H.265 `.m4s` fragment into ordered Annex-B
 * access units.
 *
 * The video codec is detected from the transport stream's PMT `stream_type`;
 * the mpegts muxer fuses parameter sets onto every IDR (SPS/PPS for H.264,
 * VPS/SPS/PPS for H.265). Each returned {@link AccessUnit} owns a detached copy
 * of the bytes. Throws on a non-H.264/H.265 stream or a failed conversion.
 *
 * @param bytes - The full `.m4s` fragment (one moov + one IDR-led GOP).
 * @param ffmpegPath - The node's pinned ffmpeg (D540). Required: no PATH default.
 * @returns Access units in source presentation order, each tagged with its codec.
 */
export async function demuxSegmentToAnnexB(
  bytes: Uint8Array,
  ffmpegPath: string,
): Promise<AccessUnit[]> {
  const ts = await runFfmpegOnce({
    ffmpegPath,
    args: SEGMENT_DEMUX_FFMPEG_ARGS,
    input: bytes,
  })
  const { codec, accessUnits } = demuxMpegTsToAnnexB(ts)
  return accessUnits.map((au) => ({
    data: au.data,
    ptsMs: au.ptsMs,
    keyframe: au.keyframe,
    codec,
  }))
}

/**
 * The ffmpeg fallback was needed and the node has no pinned binary to run it
 * with. Thrown rather than spawning a PATH `ffmpeg` (D540); the session that
 * asked names it once, per camera.
 */
export class FfmpegFallbackRefusedError extends Error {
  constructor(what: string) {
    super(`${what}: ffmpeg fallback refused — no pinned ffmpeg on this node`)
    this.name = 'FfmpegFallbackRefusedError'
  }
}
