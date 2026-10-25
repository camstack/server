/**
 * ffmpeg argv builder for recorder passthrough segmentation.
 *
 * Copied from the old recorder (`addon-pipeline/src/recorder/ffmpeg-args.ts`)
 * essentially verbatim — the passthrough + Opus-audio + fragmented-mp4 segment
 * recipe is proven across every vendor. The ONLY behavioural difference from
 * the old recorder lives in the WATCHER (recorder relocates via the v2
 * `SegmentStore.onFinalized`, not inline) — the ffmpeg invocation is identical:
 * FLAT epoch-named `.m4s` segments under `outDir` plus a rolling `live.m3u8`.
 *
 * Audio is re-encoded to **Opus** (`-c:a libopus`, in an `Opus`/`dOps`
 * ISOBMFF sample entry, verified muxable + mp4box-readable on the ffmpeg 7.x
 * builds shipped in dev/hub/agent images). Opus is what the WebRTC audio sender
 * already passes through un-transcoded (live PCMU/PCMA/OPUS => copy), so a
 * recorded fragment's audio can be read in-process (mp4box) and pushed straight
 * to the Opus sender with no per-fragment ffmpeg spawn on playback.
 */
import { segmentListSize } from './segment-watcher.js'

/** Source video codec (from the broker's `getStreamWithCodec` result). Gates
 *  the HEVC `-tag:v hvc1` sample-entry relabel — undefined = unknown, no tag. */
export type PassthroughVideoCodec = 'H264' | 'H265'

export interface PassthroughArgs {
  readonly rtspUrl: string
  readonly outDir: string
  readonly segmentSeconds: number
  /** The source video codec. When `'H265'`, the muxer is told to write the
   *  `hvc1` sample entry instead of ffmpeg's default `hev1` (passthrough, no
   *  re-encode) so Apple WebKit (native `<video>`/MSE/HLS `CODECS` and the
   *  WebCodecs scrub decoder) accepts the recording. */
  readonly videoCodec?: PassthroughVideoCodec
  /**
   * The `User-Agent` this ffmpeg puts on its RTSP dial — the ONLY identity that
   * crosses into the broker's `RtspSession`, and therefore the only key that can
   * tie a served pre-roll burst to the segment this writer produces.
   *
   * Required, not defaulted: it used to be the constant `recorder`, shared by
   * every writer on the node, which is why `restream pre-roll served` could name
   * a consumer and still identify nothing. The caller owns the per-attach value
   * (`recorder/<deviceId>/<profile>/<attachSeq>`) because only the caller knows
   * the device and the profile.
   */
  readonly consumerTag: string
}

/**
 * The `-segment_list` path a writer for `outDir` is given — spelled in ONE
 * place, because it is also how a writer is RECOGNISED in the process table.
 * The staging-directory guard (D667) looks for exactly this argv pair before
 * it lets a second ffmpeg start in the same directory; a spelling that drifted
 * between the two would make every predecessor invisible to it.
 */
export function segmentListPath(outDir: string): string {
  return `${outDir}/live.m3u8`
}

/** ffmpeg argv: pull RTSP (TCP), copy video / transcode audio to Opus, write
 *  fragmented-mp4 segments named by epoch seconds FLAT under `outDir`, plus a
 *  rolling `live.m3u8` playlist. The recorder segment-watcher tails the
 *  playlist and hands each finalized flat file to `SegmentStore.onFinalized`,
 *  which stats + relocates it into the bucket tree (`segmentRelPath`). */
export function buildPassthroughArgs(a: PassthroughArgs): readonly string[] {
  return [
    // ── ONE thread, and one filter thread ──────────────────────────────────
    //
    // This writer COPIES video and encodes a low-bitrate mono Opus track. It
    // is not a parallel job. ffmpeg nonetheless sizes its codec threads AND
    // libavfilter's slice pool to the core count, independently, per child —
    // on this 20-core hub that is ~20 threads per writer, and there is one
    // writer per camera per recorded profile: 29 processes holding 551
    // threads, measured 2026-09-18.
    //
    // The container's pid cgroup counts every one of them against a 2048
    // ceiling it was already hitting: 22 refused thread creations in 45
    // minutes, which cost a lost subject tile on camera 107, a snapshot that
    // could not open a decoder, and a dead Alexa egress — none of it announced
    // as "out of pids". Measured 20 -> 5 per writer with these two flags.
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-rtsp_transport',
    'tcp',
    // Identify this pull to the broker's RTSP server: it captures the
    // `User-Agent`, surfaces it in the stream-broker panel, and — since
    // 2026-08-20 — prints it on `restream pre-roll served` / `restream pre-roll
    // replay done`, which is what makes a broker-side burst measurement
    // checkable against a file this writer wrote. Input option → must precede
    // `-i`, or ffmpeg parses it as an output option and drops it.
    '-user_agent',
    a.consumerTag,
    '-i',
    a.rtspUrl,
    // Map ALL input streams (video + audio). Without this the segment muxer
    // selects nothing and ffmpeg aborts with "Output file does not contain
    // any stream".
    '-map',
    '0',
    // Copy the (already-fragmentable) video, but always re-encode audio to Opus.
    // The MP4 segment muxer rejects raw G.711 (pcm_mulaw/pcm_alaw, common on
    // Hikvision/ONVIF) with "codec not currently supported in container",
    // which made ffmpeg exit before writing a single frame → 0-byte segments,
    // no playlist, empty availability. The broker cannot report the source
    // audio codec reliably (it advertises AAC even for µ-law streams), so we
    // unconditionally transcode audio to Opus: cheap (low-bitrate mono/stereo),
    // muxable across every vendor (an `Opus`/`dOps` ISOBMFF sample entry), and
    // — unlike AAC — passes UN-TRANSCODED through the WebRTC audio sender on
    // recorded playback (live PCMU/PCMA/OPUS => copy), so playback reads the
    // fragment's Opus AUs in-process (mp4box) with no per-fragment ffmpeg spawn.
    // An `-c:a` with no audio stream is a no-op.
    '-c:v',
    'copy',
    // HEVC passthrough only: relabel the video sample entry from ffmpeg's
    // default `hev1` to `hvc1`. This is metadata-only (still `-c:v copy`, zero
    // re-encode / zero CPU) but it's what Apple/WebKit requires — a `hev1`
    // sample entry makes Safari's native `<video>`/MSE and the WebCodecs scrub
    // decoder (`VideoDecoder.isConfigSupported`) reject the HEVC stream even
    // though the VideoToolbox HEVC decoder is present. NEVER tag an H.264 copy
    // as hvc1 — the tag must match the actual codec, hence the H265 gate.
    ...(a.videoCodec === 'H265' ? (['-tag:v', 'hvc1'] as const) : []),
    // libopus at 48 kb/s: transparent for the mono voice most cameras carry and
    // adequate for stereo. No `-ac` — keep the source channel layout so a
    // stereo camera stays stereo. `-vbr on` (libopus default) adapts the rate.
    '-c:a',
    'libopus',
    '-b:a',
    '48k',
    '-f',
    'segment',
    '-segment_time',
    String(a.segmentSeconds),
    '-segment_format',
    'mp4',
    '-segment_format_options',
    'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-reset_timestamps',
    '1',
    '-strftime',
    '1',
    '-segment_list',
    segmentListPath(a.outDir),
    '-segment_list_type',
    'm3u8',
    // BOUND the playlist. The muxer default is 0 = "every segment for the
    // writer's whole life", and `parseLivePlaylist` re-parses the whole body
    // every 2 s per writer: 3.3 MB/s across 30 writers at 5 h uptime, growing
    // linearly, capped by nothing. `segmentListSize` derives the entry count
    // from what the WATCHER still has to answer for (the held-back tail plus
    // the pending-file grace and one worst-case pass), not from a round number.
    //
    // Verified on the ffmpeg the hub image actually ships (6.1.1-3ubuntu5):
    // 12 segments with `-segment_list_size 4` produce 4 entries and
    // `#EXT-X-MEDIA-SEQUENCE:8`; the same run unbounded produces 12 entries and
    // `:0`. The muxer rewrites the file in place and maintains the sequence —
    // which is the offset `planFinalizations` needs, because a rolling window
    // makes a body index a different segment after every roll.
    '-segment_list_size',
    String(segmentListSize(a.segmentSeconds)),
    // FLAT epoch-named segments directly under `outDir`. We deliberately do
    // NOT let ffmpeg write the date buckets: its segment muxer cannot create
    // directories on this ffmpeg build (`-strftime_mkdir` is absent) and its
    // `-strftime` expands in LOCAL time, whereas the playback layout
    // (`segmentRelPath`) is UTC. The watcher passes the flat path to the v2
    // SegmentStore, which relocates into the UTC bucket so disk + playback
    // URIs stay consistent.
    `${a.outDir}/%s.m4s`,
  ]
}
