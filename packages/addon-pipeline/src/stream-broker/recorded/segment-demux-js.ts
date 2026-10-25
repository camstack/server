/**
 * segment-demux-js — PURE-JS in-process demux for recorded playback.
 *
 * {@link demuxSegmentFullJs} / {@link demuxSegmentPreferJs} — FULL playback
 * (every access unit, sync + delta), the drop-in for `RecordedFeederDeps.demux`.
 * Both playback AND scrub demux through this since sweep mode (the scrub train
 * pushes predicted frames, so the whole GOP is needed either way).
 *
 * Replaces the per-fragment ffmpeg spawn (a ~140 ms subprocess floor) with an
 * in-process mp4box parse. A recorded `.m4s`
 * is a self-contained fragment (`+frag_keyframe+empty_moov+default_base_moof`)
 * carrying its own `moov`, so its `avcC`/`hvcC` parameter sets and its sync
 * sample(s) are all in the bytes we already hold — no init segment to fetch.
 *
 * Flow: {@link extractSamples} (the proven mp4box demux the recorder scrub
 * module already ships — box parsing is NOT duplicated here) yields the codec
 * `description` + length-prefixed samples; sync samples are fused with their
 * parameter sets ({@link buildKeyframeAnnexB}), delta samples converted plain
 * ({@link avccSampleToAnnexB}). `ptsMs` is segment-relative (anchored to 0 at
 * the first sample), exactly like the ffmpeg demux's PES-derived deltas —
 * `clampIntoSegment`/position reporting are unaffected.
 */
import { extractSamples } from '../../recorder/scrub/fmp4-keyframes.js'
import { avccSampleToAnnexB, buildKeyframeAnnexB, parseNalLengthSize } from './avcc-annexb.js'
import type { DemuxPathOutcome } from './demux-path-tally.js'
import {
  demuxSegmentToAnnexB,
  FfmpegFallbackRefusedError,
  type AccessUnit,
} from './segment-demux.js'

/** JS parse of one fragment — in-process mp4box, or a worker_threads stand-in. */
export type JsParseFn = (
  bytes: Uint8Array,
  ctx?: { readonly deviceId?: number },
) => Promise<AccessUnit[] | null>

/** True for a WebCodecs codec string that is HEVC (`hvc1.`/`hev1.`), else H.264. */
function isHevcCodec(codec: string): boolean {
  return /^h[ev][vc]1\./i.test(codec)
}

/**
 * Pure-JS FULL-playback demux of one self-contained `.m4s` fragment: return
 * EVERY access unit (sync + delta) as params-fused Annex-B with segment-relative
 * `ptsMs`, matching the {@link AccessUnit} contract of {@link demuxSegmentToAnnexB}
 * (the ffmpeg mpegts path). Returns `null` if mp4box found no video / no
 * decodable sample (caller falls back to ffmpeg).
 *
 * Each sync sample is emitted through {@link buildKeyframeAnnexB} (parameter sets
 * fused ahead of the IDR — SPS/PPS for H.264, VPS/SPS/PPS for H.265); each delta
 * sample is emitted through {@link avccSampleToAnnexB} (its VCL NALs converted
 * from length-prefixed AVCC/HVCC to Annex-B, no parameter sets). `ptsMs` is the
 * sample composition time anchored to 0 at the first sample — the same
 * segment-relative timeline the ffmpeg PES-PTS path produces.
 *
 * Throws only on a genuinely malformed decoder config / sample; the wrapper
 * ({@link demuxSegmentPreferJs}) turns that into an ffmpeg fallback.
 */
export async function demuxSegmentFullJs(bytes: Uint8Array): Promise<AccessUnit[] | null> {
  // segmentStartMs = 0 ⇒ each sample's `ts` is a segment-relative ms offset
  // (0 for the first sample), matching the AccessUnit.ptsMs contract.
  const extracted = await extractSamples(bytes, 0)
  if (!extracted || extracted.samples.length === 0) return null

  const isHevc = isHevcCodec(extracted.codec)
  const codec = isHevc ? 'H265' : 'H264'
  const nalLengthSize = parseNalLengthSize(extracted.description, isHevc)
  const aus: AccessUnit[] = extracted.samples.map((s) => ({
    data: s.isSync
      ? buildKeyframeAnnexB(s.data, extracted.description, isHevc)
      : avccSampleToAnnexB(s.data, nalLengthSize),
    ptsMs: s.ts,
    keyframe: s.isSync,
    codec,
  }))
  return aus
}

/** Options for the JS-preferred full demux + ffmpeg fallback. */
export interface FullDemuxOptions {
  /**
   * The node's pinned ffmpeg for the fallback demux (D540). REQUIRED, and
   * `null` when the node has none: the fallback then throws
   * {@link FfmpegFallbackRefusedError} instead of running a PATH `ffmpeg`.
   */
  readonly ffmpegPath: string | null
  /**
   * Override the JS parse (default {@link demuxSegmentFullJs}). The broker
   * injects a worker_threads parse so mp4box does not occupy the live
   * restream event loop (D228).
   */
  readonly jsParse?: JsParseFn
  /** Device the fragment belongs to; tags the off-thread worker's log lines. */
  readonly deviceId?: number
  /**
   * Called once per demux with WHICH path served it — `js` for the JS
   * mp4box parse, `ffmpeg` (with the reason the JS parse was rejected) for the
   * subprocess fallback.
   *
   * Both outcomes, deliberately. The previous hook fired only on the fallback
   * and the broker logged it once per session, so the RATE — the number that
   * decides whether the in-process path is a real saving or a decoration — was
   * unknowable. A counter that only ever hears about failures cannot answer
   * "how often do we fall back".
   */
  readonly onDemuxPath?: (outcome: DemuxPathOutcome) => void
}

/**
 * Feeder FULL-playback demux: try the pure-JS extractor first, fall back to the
 * ffmpeg spawn ({@link demuxSegmentToAnnexB}) if the JS parse yields no access
 * unit or throws on malformed bytes. Preserves the exact {@link AccessUnit}
 * contract either way, so it is a drop-in for `RecordedFeederDeps.demux`.
 */
export async function demuxSegmentPreferJs(
  bytes: Uint8Array,
  opts: FullDemuxOptions,
): Promise<AccessUnit[]> {
  try {
    const parse = opts.jsParse ?? demuxSegmentFullJs
    const js = await parse(
      bytes,
      opts.deviceId === undefined ? undefined : { deviceId: opts.deviceId },
    )
    if (js && js.length > 0) {
      opts.onDemuxPath?.({ path: 'js' })
      return js
    }
    opts.onDemuxPath?.({ path: 'ffmpeg', reason: 'mp4box parse found no access units' })
  } catch (err) {
    opts.onDemuxPath?.({ path: 'ffmpeg', reason: `mp4box parse threw: ${String(err)}` })
  }
  if (opts.ffmpegPath === null) throw new FfmpegFallbackRefusedError('recorded video demux')
  return demuxSegmentToAnnexB(bytes, opts.ffmpegPath)
}
