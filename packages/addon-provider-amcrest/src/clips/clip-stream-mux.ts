/**
 * The pure half of an Amcrest clip stream's mux: what ffmpeg is told.
 *
 * ## One input, not two — and that is a measurement, not a shortcut
 *
 * The Hikvision path depacketizes RTP itself and feeds ffmpeg an Annex-B
 * elementary stream plus a µ-law pipe, because that firmware's replay is a
 * proprietary session with no frame rate on the wire: a rate it cannot measure
 * would be muxed at ffmpeg's 25 fps default and play a 13 fps clip at half
 * speed (D604, D616). None of that is true here. `/cam/playback` is **plain
 * RTSP**: an SDP that names both tracks, `packetization-mode=1` H.264 with
 * `sprop-parameter-sets` inline, and RTP timestamps on a 90 kHz clock.
 * ffmpeg's own demuxer reads all of it, so there is no rate to probe and no
 * second pipe to hold the video hostage.
 *
 * ## The archive's sound is AAC, so a stream that carries sound TRANSCODES
 *
 * Measured: `a=rtpmap:97 MPEG4-GENERIC/8000`, AAC-LC 8 kHz mono, complete over
 * the whole clip (528 audio RTP against 528 audio frames in the file). No
 * WebRTC session speaks AAC, so `opus` and `pcmu` are both an encode — where
 * Hikvision's µ-law archive makes `pcmu` a copy. D600 verbatim, as the
 * feasibility note predicted.
 *
 * ## The two flags that are most of the operator's wait
 *
 * `-analyzeduration` 5 s and `-probesize` 5 MB are ffmpeg's defaults, and a
 * realtime-bound source pays them in wall clock (D616). Nothing is being
 * discovered: the SDP already names both codecs and carries the parameter
 * sets. Measured from the hub container against 3836 on 2026-09-23 with these
 * flags and `-frag_duration`: **first byte at 1 352 ms**, against 74 475 ms
 * for the whole-file fetch the same clip takes today.
 *
 * `-frag_keyframe` alone closes the first fragment at the next keyframe, which
 * on this camera's 4 s GOP is 4 s of a realtime source; `-frag_duration`
 * closes it on a half-second instead, and the broker's fMP4 demuxer does not
 * require a fragment to begin at a keyframe.
 */

/** The fragmented container a STREAM is muxed into — no `moov` to wait for. */
export const CLIP_STREAM_MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof'

/** How much of the input ffmpeg may read before it writes a header (D616). */
export const CLIP_MUX_PROBE_BYTES = 32_768

/** How long a fragment may run before it is closed, keyframe or not (D616). */
export const CLIP_STREAM_FRAG_DURATION_US = 500_000

/** Mono: a camera microphone is one channel and a session sends one. */
export const CLIP_STREAM_AUDIO_CHANNELS = 1
/** Opus has one rate, and it is the session's RTP clock. */
export const CLIP_STREAM_OPUS_RATE_HZ = 48_000
/** The PCMU RTP clock. */
export const CLIP_STREAM_PCMU_RATE_HZ = 8_000
/** What the other two clip paths encode Opus at, so the three sound alike. */
export const CLIP_STREAM_OPUS_BITRATE = '24k'

/**
 * How the audio timeline is rebuilt before it reaches the encoder.
 *
 * **This camera's audio timestamps do not advance by a frame.** An AAC-LC
 * frame at 8 kHz is 1 024 samples — 0.128 s, the only duration it can have —
 * and measured over one clip on 3836 (2026-09-23) the deltas the camera
 * stamps are 0.098, 0.108, 0.118, 0.128, 0.138, 0.148, 0.158 and 0.168 s.
 * ffmpeg carries that jitter through to the libopus encoder's OUTPUT
 * timestamps, the mp4 muxer finds them non-monotonic, and it DROPS the
 * packet rather than writing it.
 *
 * Measured on one 30 s bound of the same session: **299 `Non-monotonic DTS`
 * drops at the audio encoder, and 4.24 s of opus in the output where the same
 * RTSP session decoded 45.95 s of intact AAC.** That is the operator's
 * "audio distorted" — nine tenths of the sound thrown away, and the tenth
 * that survives compressed onto a timeline that does not fit it.
 *
 * `async=1` tells the resampler to stretch or pad to keep the audio aligned
 * with a continuous timeline derived from the SAMPLE COUNT, which is where
 * the truth is: 169 frames is 21.6 s of sound whatever the camera says about
 * when it sent them. `first_pts=0` starts that timeline at the origin rather
 * than at whatever the camera's first stamp happened to be.
 *
 * It is a per-OUTPUT filter and is emitted only where there is an encoder to
 * feed: `-af` with no audio output stream is an ffmpeg error, not a no-op.
 */
export const CLIP_STREAM_AUDIO_RESYNC_FILTER = 'aresample=async=1:first_pts=0'

/**
 * How long the muxer may hold one track's packets WAITING for the other.
 *
 * Inherited verbatim from the Hikvision mux, because it is a fact about
 * ffmpeg's muxers and not about a camera. ffmpeg interleaves the two output
 * tracks and its default window is TEN SECONDS; on a source that arrives at
 * realtime that window is paid in the operator's wait, and it is seen as a
 * picture that stops. Measured on 3836 as byte-arrival plateaus of 1 s, 3 s
 * and 3 s inside a single 19 s stream, the last ending in a 3.1 MB burst.
 *
 * **`0` does not mean "no window". It means UNLIMITED**, which is the fault.
 * The value has to be small and positive. 100 ms is longer than any gap
 * between this camera's frames — its audio frames are 128 ms nominal, its
 * video around 34 ms — and short enough that no consumer notices.
 */
export const CLIP_STREAM_MAX_INTERLEAVE_DELTA_US = 100_000

/**
 * The fd ffmpeg's machine-readable progress is written to.
 *
 * **Not stderr.** stderr is where the camera's own sentence arrives, it is
 * kept to its last 4 000 characters so a refusal can be classified and quoted,
 * and a progress block every half second would evict that sentence long before
 * anybody read it. `-progress pipe:2` was therefore never an option; a fourth
 * pipe costs one descriptor and keeps the two streams the two things they are.
 *
 * Verified against the hub container's own ffmpeg, 2026-09-24: `-progress
 * pipe:3` with `stdio[3]` open writes `frame=` / `out_time_us=` blocks there
 * and NOTHING to stderr — an empty stderr on a clean run, which is what
 * {@link classifyMuxFailure} depends on.
 */
export const CLIP_STREAM_PROGRESS_FD = 3

/** What one `-progress` report says about the media that has been written. */
export interface ClipStreamProgress {
  /** Video frames written. `null` when no block has named one. */
  readonly frames: number | null
  /** Media written, in seconds. `null` when no block has named one. */
  readonly deliveredSeconds: number | null
}

/**
 * The last thing ffmpeg's `-progress` said about the output.
 *
 * Fed the WHOLE accumulated text rather than one block, because that is what
 * the producer holds and because a run that ends badly may have half a block
 * at the tail. Every key is read independently and the LAST readable value of
 * each wins: measured, the first block of a live mux carries `frame=0` and
 * `out_time_us=N/A`, so a parser that takes the first block, or that demands
 * both keys from one block, reports nothing on a stream that delivered
 * plenty.
 *
 * `out_time_us` is the last frame's presentation stamp, not the end of its
 * interval — a 3 s, 30-frame test source reports 2 700 000 µs. It under-states
 * by one frame interval, which is why the tolerance in `clip-truncation.ts`
 * has room for it rather than the parser inventing a correction.
 */
export function parseClipStreamProgress(text: string): ClipStreamProgress {
  return {
    frames: lastNumeric(text, /^frame=\s*(\d+)\s*$/gm),
    deliveredSeconds: lastMicroseconds(text),
  }
}

function lastNumeric(text: string, pattern: RegExp): number | null {
  let found: number | null = null
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1])
    if (Number.isFinite(value)) found = value
  }
  return found
}

function lastMicroseconds(text: string): number | null {
  const micros = lastNumeric(text, /^out_time_us=\s*(-?\d+)\s*$/gm)
  // Negative is ffmpeg's "before the origin" and zero is a stream that wrote a
  // header and no sample: neither is a duration, and neither may be reported
  // as one (D393).
  if (micros === null || micros <= 0) return null
  return micros / 1_000_000
}

/** The audio codec a stream is muxed with — never `none`, which is absence. */
export type ClipStreamAudioCodec = 'opus' | 'pcmu'

/** What a caller may ask a stream to carry. `none` is a real ask. */
export type ClipStreamAudioAsk = ClipStreamAudioCodec | 'none'

/**
 * MEASURED on the Hikvision path and inherited here, because it is a fact
 * about ffmpeg's muxers and not about a camera: the MP4 muxer refuses
 * `pcm_mulaw` (`Could not find tag for codec pcm_mulaw in stream #1`) and the
 * MOV muxer takes it as a `ulaw` sample entry. The boxes a consumer walks are
 * the same either way.
 */
export function clipStreamContainerFor(audio: ClipStreamAudioCodec | null): 'mp4' | 'mov' {
  return audio === 'pcmu' ? 'mov' : 'mp4'
}

/** What the route puts on `content-type` for {@link clipStreamContainerFor}. */
export function clipStreamContentTypeFor(audio: ClipStreamAudioCodec | null): string {
  return clipStreamContainerFor(audio) === 'mov' ? 'video/quicktime' : 'video/mp4'
}

export interface ClipStreamMuxArgsInput {
  /** The credentialled `/cam/playback` URL. Never logged. */
  readonly url: string
  readonly audio: ClipStreamAudioAsk
  readonly probeBytes?: number
  readonly fragDurationUs?: number
}

/**
 * The one spelling of the mux, so a test can read it back and the producer
 * cannot grow a second opinion.
 *
 * `-c:v copy`: the archive is already H.264 and a re-encode of a recording we
 * are only re-containerising can lose and cannot gain.
 */
export function buildClipStreamMuxArgs(input: ClipStreamMuxArgsInput): readonly string[] {
  const probe = String(input.probeBytes ?? CLIP_MUX_PROBE_BYTES)
  const frag = String(input.fragDurationUs ?? CLIP_STREAM_FRAG_DURATION_US)
  const container = clipStreamContainerFor(input.audio === 'none' ? null : input.audio)
  const audioArgs: readonly string[] =
    input.audio === 'opus'
      ? [
          '-c:a',
          'libopus',
          '-b:a',
          CLIP_STREAM_OPUS_BITRATE,
          '-ar',
          String(CLIP_STREAM_OPUS_RATE_HZ),
          '-ac',
          String(CLIP_STREAM_AUDIO_CHANNELS),
          '-af',
          CLIP_STREAM_AUDIO_RESYNC_FILTER,
        ]
      : input.audio === 'pcmu'
        ? [
            '-c:a',
            'pcm_mulaw',
            '-ar',
            String(CLIP_STREAM_PCMU_RATE_HZ),
            '-ac',
            String(CLIP_STREAM_AUDIO_CHANNELS),
            '-af',
            CLIP_STREAM_AUDIO_RESYNC_FILTER,
          ]
        : ['-an']
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    // TCP, never UDP: the camera interleaves both tracks on the control
    // socket, which is what makes an abandoned session free its slot the
    // moment the socket dies rather than on an RTCP timeout.
    '-rtsp_transport',
    'tcp',
    // An input option applies only to the input that follows it (D616).
    '-analyzeduration',
    '0',
    '-probesize',
    probe,
    '-i',
    input.url,
    '-c:v',
    'copy',
    ...audioArgs,
    '-f',
    container,
    '-movflags',
    CLIP_STREAM_MOVFLAGS,
    '-frag_duration',
    frag,
    // THE flag that keeps a two-track clip stream ARRIVING rather than
    // piling up behind a ten-second interleave window. See
    // {@link CLIP_STREAM_MAX_INTERLEAVE_DELTA_US}.
    '-max_interleave_delta',
    String(CLIP_STREAM_MAX_INTERLEAVE_DELTA_US),
    // Without this the AVIO buffer holds the init segment until 32 KiB has
    // piled up behind it, so the peer sees nothing at all — not even `ftyp` —
    // until the first fragment closes (D616).
    '-flush_packets',
    '1',
    // The MEASUREMENT, on its own fd. Without it the only thing this producer
    // knows about a finished stream is ffmpeg's exit code, and this camera
    // exits 0 on a replay it truncated (D623).
    '-progress',
    `pipe:${String(CLIP_STREAM_PROGRESS_FD)}`,
    'pipe:1',
  ]
}
