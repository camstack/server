/**
 * THE ffmpeg argv builder. Every ffmpeg this repo spawns for a LIVE MEDIA
 * transcode — the broker transcode pool, the WebRTC transcode leg, a derived
 * stream, HomeKit's SRTP egress, Alexa — assembles its argument list here.
 *
 * It lives in `@camstack/types` rather than in an addon for one reason: three
 * addons need it (`addon-pipeline`, `addon-export-hap`, `addon-export-alexa`)
 * and addons may never import each other. `@camstack/types` is the framework
 * package all three already depend on, and it already owns `EncodeProfile`.
 *
 * The builder is PURE — argument list only. The binary path comes from
 * `system-config`'s `ffmpeg.binaryPath` and goes to `spawn` separately (see
 * `../ffmpeg-node/process.js` for the lifecycle wrapper).
 *
 * ## The one rule this file exists to enforce
 *
 * **`-hwaccel` is an INPUT option.** ffmpeg accepts it after `-i` without any
 * error and then silently decodes in software: the CPU cost stays, the GPU is
 * idle, and the log line still says "using hardware decode". Everything that
 * configures the INPUT is emitted by {@link buildInputArgs} strictly before
 * `-i`; everything that configures an OUTPUT comes after. `__tests__/
 * ffmpeg-invocation.spec.ts` asserts INDEXES, never membership.
 */
import type { AudioEncode, EncodeProfile } from '../encode-profile.js'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The three facts a headerless raw-video stream cannot state about itself. */
export interface FfmpegRawVideoInput {
  readonly pixelFormat: string
  readonly width: number
  readonly height: number
  readonly framerate: number
}

/** Everything that configures the ffmpeg INPUT. Emitted strictly before `-i`. */
export interface FfmpegInputPlan {
  /** An RTSP url, a `pipe:0` stdin feed, or a file path. */
  readonly url: string
  /**
   * `-rtsp_transport`. `null` for a non-RTSP input (stdin, file). TCP is the
   * only value in production use: the broker's loopback restreams are TCP and
   * UDP loses packets under a burst.
   */
  readonly rtspTransport?: 'tcp' | 'udp' | null
  /** `-fflags` values, e.g. `['+discardcorrupt']`, `['+genpts']`. */
  readonly fflags?: readonly string[]
  /**
   * `-analyzeduration` (microseconds) and `-probesize` (bytes): how long ffmpeg
   * inspects the input before it emits ANYTHING.
   *
   * Unset means ffmpeg's defaults — 5 s and 5 MB — and on a live egress pull
   * that is a five-second stall before the first packet, paid by whoever is
   * staring at the player. Measured on the live hub: a HomeKit session on a
   * 9 fps slot took 9 s from `stream started` to the first packet out of
   * ffmpeg and 12.2 s to the first key frame. The SLOWER the slot, the longer
   * the wait, because the default budget is wall-clock over an input that
   * delivers few frames per second — which is why the 25 fps slot looked fine
   * and the 9 fps one looked broken.
   *
   * Safe to shrink on RTSP specifically: the SDP already declares the codec,
   * so there is nothing for the probe to discover. Leave unset for inputs that
   * genuinely need discovery (a file of unknown provenance, a raw pipe).
   */
  readonly analyzeDurationUs?: number
  readonly probeSizeBytes?: number
  /**
   * `-threads` for the DECODER, emitted before `-i`.
   *
   * Distinct from {@link FfmpegInvocation.threadCount}, which lands after the
   * video args and therefore bounds the ENCODER only. Nothing bounded the
   * decoder at all until 2026-09-18, and that is where the threads were: left
   * at auto, libavcodec creates `min(cores, 16)` frame threads per input, on a
   * 20-core hub, per child.
   *
   * Measured the same day: a grid tile reading a 1080p sub-stream held 72
   * threads; with this set to 1 and `filterThreadCount` to 1 it holds 26. The
   * container's pid cgroup counts every one against a 2048 ceiling it was
   * actively refusing at.
   *
   * A parallel decode is still a real thing — a 4K software decode at 25 fps
   * cannot keep up single-threaded — so this is a number, not a flag.
   */
  readonly decodeThreadCount?: number
  /**
   * A headerless stream of raw frames — `-f rawvideo` and the three facts that
   * demuxer cannot discover for itself.
   *
   * Raw video carries no container and no metadata, so ffmpeg cannot know the
   * pixel format, the frame size or the rate: given none of them it guesses,
   * and the guess is wrong in a way that produces a picture rather than an
   * error — skewed, tinted, or played at the wrong speed. All three are
   * therefore REQUIRED together here, rather than three optional fields that
   * could be set one at a time.
   *
   * Used by a composition this repo assembles ITSELF (`grid-compositor.ts`),
   * where the frames come from our own canvas and every one of these three is a
   * fact we chose.
   */
  readonly rawVideo?: FfmpegRawVideoInput
  /**
   * `-flags low_delay` on this INPUT.
   *
   * ffmpeg's h264 decoder reorders its output to undo B-frame ordering, so it
   * holds each frame until it knows nothing following will precede it. On a
   * stream encoded without B-frames there is nothing to reorder and the wait
   * buys nothing — it is latency added at every hop that decodes, and a
   * composite decodes one per tile.
   *
   * Ask for it only where the producer is known to emit no B-frames (the hub's
   * own restreams, an encoder we configured with `-tune zerolatency`). On an
   * arbitrary camera it is not wrong, just not always free: a stream that DOES
   * reorder will decode out of order.
   */
  readonly lowDelay?: boolean
  /**
   * `-use_wallclock_as_timestamps 1` — stamp this input by ARRIVAL time.
   *
   * ffmpeg normalises each input so its first frame is pts 0, and a filter that
   * pairs inputs (`overlay`) pairs them BY PTS. Two sources that joined at
   * different moments therefore compose frames from different moments, for the
   * life of the child, with nothing to correct it: each tile's clock started
   * whenever that tile's first frame happened to arrive.
   *
   * The spread is real. Four joins of the SAME restream in one series measured
   * 1830 / 3987 / 3985 / 4025 ms (hub, 2026-09-18) — a `/muted` dial is served
   * at once only within ~500 ms of an IDR and otherwise waits for the next, so
   * two tiles of one composite can start a key-frame interval apart.
   *
   * It is NOT, however, the skew a composite normally has. Measured the same
   * day: two sources joined in PARALLEL landed 438-599 ms apart, while the same
   * two inside one ffmpeg were 4-5 s apart — because ffmpeg opens its inputs
   * SEQUENTIALLY and each open blocks until its probe budget is spent. Shrink
   * `analyzeDurationUs` / `probeSizeBytes` before reaching for this flag: on
   * the live grid that alone took the skew to 0-1 s, and this flag cost the
   * output pacing ten stalls over a second in an 18 s run.
   *
   * Ask for it where several inputs must agree about WHEN. A single-input
   * transcode does not care and should leave it alone: wall-clock stamping ties
   * the output's timing to this machine's clock rather than to the source's.
   */
  readonly useWallclockTimestamps?: boolean
  /** Caller-supplied input options (an `EncodeProfile.inputArgs`, probe flags). */
  readonly extraArgs?: readonly string[]
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/** ffmpeg video encoder ids the repo selects between. */
export type FfmpegVideoEncoderId =
  | 'libx264'
  | 'libx265'
  | 'h264_videotoolbox'
  | 'hevc_videotoolbox'
  | 'h264_vaapi'
  | 'hevc_vaapi'
  | 'h264_qsv'
  | 'hevc_qsv'
  | 'h264_nvenc'
  | 'hevc_nvenc'
  | 'h264_amf'
  | 'hevc_amf'

/**
 * How the encoder is bounded.
 *
 * - `'cbr'` — a TARGET bitrate plus a matching peak (`-b:v` + `-maxrate`).
 *   What a real-time egress with a fixed budget wants.
 * - `'cap'` — a CEILING only (`-maxrate`, no `-b:v`): the encoder spends less
 *   on an easy scene but never exceeds the bound.
 *
 * `vbvSeconds` is the VBV window as a multiple of the bitrate. One second is a
 * tight window that keeps instantaneous rate near the target (HomeKit's link
 * budget is per-second); two seconds lets a keyframe spike borrow from the next
 * second, which is what a browser viewer wants.
 */
export type FfmpegRateControl =
  | { readonly kind: 'cbr'; readonly vbvSeconds: number }
  | { readonly kind: 'cap'; readonly vbvSeconds: number }

/** Fit-inside (never upscale, even dimensions) vs an exact rescale. */
export interface FfmpegScalePlan {
  readonly mode: 'fit' | 'exact'
  readonly width: number
  readonly height: number
}

export interface FfmpegVideoEncodePlan {
  readonly kind: 'encode'
  readonly encoder: FfmpegVideoEncoderId
  readonly scale?: FfmpegScalePlan | null
  readonly preset?: string
  readonly tune?: string
  /** One slice per access unit — see `VideoEncodeSchema.singleSlicePerFrame`. */
  readonly singleSlicePerFrame?: boolean
  /** `-profile:v` — baseline / main / high. */
  readonly profile?: string
  /**
   * `-level`. Omitting this while advertising a level in SDP is the defect
   * that kept HomeKit black for a year and that Alexa shipped too: a stream
   * that does not match its own advertisement.
   */
  readonly level?: string
  readonly pixelFormat?: string
  readonly fps?: number
  readonly gopFrames?: number
  /**
   * `-force_key_frames expr:gte(t,n_forced*<sec>)` — an IDR every `<sec>`
   * seconds of OUTPUT time, regardless of what the source does.
   *
   * Only a fragmented-MP4 consumer needs this today, and it needs it for a
   * structural reason rather than a quality one: an fMP4 fragment written with
   * `frag_keyframe` is cut at a key frame, so the key-frame cadence IS the
   * fragment cadence. `-g` bounds the GOP the encoder would choose anyway;
   * this pins the boundary to a wall-clock grid the muxer can meet.
   *
   * Structurally absent from {@link FfmpegVideoCopyPlan}: a copy has no
   * encoder to instruct, and ffmpeg accepts the flag there, warns, and ignores
   * it — the silent-no-op shape this file exists to prevent.
   */
  readonly forceKeyFramesSeconds?: number
  readonly bf?: number
  readonly bitrateKbps?: number
  readonly rateControl?: FfmpegRateControl
  /** `-bsf:v`, e.g. `dump_extra` when the consumer negotiates its own SDP. */
  readonly bitstreamFilter?: string
}

export interface FfmpegVideoCopyPlan {
  readonly kind: 'copy'
  readonly bitstreamFilter?: string
}

/**
 * Decode, filter, and hand the PIXELS on — no encoder at all.
 *
 * The one consumer is a composition this repo assembles itself
 * (`grid-compositor.ts`): its tiles are copied into a canvas, so encoding them
 * on the way out and decoding them again on the way in would be two codecs paid
 * to deliver the frames that were already there.
 *
 * `pixelFormat` is REQUIRED, unlike on an encode plan where it is a hint.
 * Raw frames carry no header, so their format is not written down anywhere on
 * the wire: whoever reads them has to be told, and a default here would be a
 * fact one side knows and the other guesses.
 */
export interface FfmpegVideoRawPlan {
  readonly kind: 'raw'
  readonly pixelFormat: string
  /** A simple `-vf` chain (crop, scale). Never combined with a filter graph. */
  readonly filter?: string
  readonly fps?: number
}

export type FfmpegVideoPlan = FfmpegVideoCopyPlan | FfmpegVideoEncodePlan | FfmpegVideoRawPlan

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export type FfmpegAudioCodecId = 'opus' | 'aac' | 'pcmu' | 'pcma'

const AUDIO_ENCODER_BY_CODEC: Readonly<Record<FfmpegAudioCodecId, string>> = {
  opus: 'libopus',
  aac: 'aac',
  pcmu: 'pcm_mulaw',
  pcma: 'pcm_alaw',
}

export interface FfmpegAudioEncodePlan {
  readonly kind: 'encode'
  readonly codec: FfmpegAudioCodecId
  readonly bitrateKbps?: number
  readonly sampleRateHz?: number
  readonly channels?: number
  /** libopus `-application` — `lowdelay` for a real-time two-way leg. */
  readonly application?: 'lowdelay' | 'voip' | 'audio'
  /** libopus `-frame_duration` in ms — negotiated per consumer session. */
  readonly frameDurationMs?: number
  /** `-bufsize` for the audio plane, in kbit. */
  readonly vbvBufferKbits?: number
  /** `-flags +global_header` — required when the consumer owns the SDP. */
  readonly globalHeader?: boolean
  /** `-af` filter chain, e.g. `aresample=async=1000:first_pts=0`. */
  readonly filter?: string
}

export type FfmpegAudioPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'copy' }
  | FfmpegAudioEncodePlan

/**
 * Camera-microphone audio, per codec. Lives HERE rather than in
 * `encode-defaults.ts` only to avoid an import cycle (`encode-defaults` depends
 * on these types); it is re-exported from there, which is where to read it.
 *
 * Every source in this repo is a mono camera mic. The former broker preset
 * encoded Opus at `channels: 2`, spending bitrate duplicating one channel —
 * that is the value this consolidation changed.
 */
export const AUDIO_PRESETS: Readonly<Record<'aac' | 'opus' | 'pcmu', FfmpegAudioEncodePlan>> = {
  aac: {
    kind: 'encode',
    codec: 'aac',
    bitrateKbps: 128,
    sampleRateHz: 48000,
    channels: 1,
  },
  opus: {
    kind: 'encode',
    codec: 'opus',
    bitrateKbps: 64,
    sampleRateHz: 48000,
    channels: 1,
  },
  pcmu: { kind: 'encode', codec: 'pcmu', sampleRateHz: 8000, channels: 1 },
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

/** One RTP output leg. The payload type / SSRC / MTU are the CONSUMER's facts. */
export interface FfmpegRtpOutput {
  /** `rtp://host:port[?pkt_size=N]`. */
  readonly url: string
  readonly payloadType?: number
  /** ffmpeg parses `-ssrc` as a SIGNED int32 — callers coerce with `| 0`. */
  readonly ssrc?: number
  /** Path ffmpeg writes this output's SDP to (`-sdp_file`). */
  readonly sdpFile?: string
}

/**
 * A fragmented-MP4 bytestream on stdout: `ftyp`+`moov` once, then a
 * `moof`+`mdat` per fragment. The shape HomeKit Secure Video's recording
 * delegate consumes, and the shape a CamStack clip source can consume from the
 * same child (D67's primitive, one fragmenter, two consumers).
 *
 * ## Why `frag_keyframe` + `min_frag_duration`, and NOT `frag_duration`
 *
 * HKSV requires every media fragment to START on a sync sample. `frag_keyframe`
 * cuts a fragment at each key frame, which satisfies that by construction.
 * `-frag_duration` cuts at a wall-clock boundary *whether or not* a key frame
 * has arrived, so a source whose IDR is late produces a fragment that opens on
 * a delta frame — accepted by the muxer, rejected by the consumer, and
 * invisible in an argv test. `-min_frag_duration` is the safe half of the pair:
 * it only ever DELAYS a cut, so the boundary stays a key frame and a source
 * with a 1 s GOP does not emit four fragments where one was negotiated.
 *
 * The consequence, stated because it decides what the caller must do: the
 * fragment length is the key-frame cadence, so a caller that wants ~N-second
 * fragments must also pin {@link FfmpegVideoEncodePlan.forceKeyFramesSeconds}.
 * On a `copy` plan it cannot, and the fragment length is then whatever the
 * SOURCE's GOP makes it — `fragmentMs` becomes a floor, not a target.
 */
export interface FfmpegFmp4Sink {
  readonly kind: 'stdout'
  readonly container: 'mp4'
  /**
   * The negotiated fragment length in milliseconds. Emitted as
   * `-min_frag_duration` (microseconds) at {@link FMP4_MIN_FRAG_MARGIN} of this
   * value — read that constant before changing anything here, the margin is
   * what stops a camera whose GOP equals `fragmentMs` emitting fragments at
   * twice the requested length.
   */
  readonly fragmentMs: number
}

export type FfmpegSink =
  | { readonly kind: 'rtsp-listen'; readonly url: string }
  /**
   * A container written to stdout.
   *
   * `flv` exists for a producer whose consumer is the broker's ffmpeg source
   * reader: that reader re-muxes with `-c copy -f mpegts`, and the bundled
   * ffmpeg 7.0.2 static SEGFAULTS on an MPEG-TS input on that path — measured
   * on the hub 2026-09-17, on a synthetic three-second stream as readily as on
   * a real one, while RTSP→TS and FLV→TS copy both exit 0. A producer that
   * hands the broker MPEG-TS therefore hands it a crash; FLV is the format the
   * broker already documents as "always ingested through the ffmpeg source
   * reader" (`pull-flv`).
   */
  | {
      readonly kind: 'stdout'
      readonly container: 'h264' | 'hevc' | 'mpegts' | 'flv' | 'rawvideo'
    }
  | FfmpegFmp4Sink
  /**
   * Two independent mapped RTP outputs. Generic ffmpeg RTP vocabulary — the
   * SRTP encryption, the port allocation and the payload-type numbers stay
   * with the consumer that negotiated them.
   */
  | {
      readonly kind: 'rtp-outputs'
      readonly video: FfmpegRtpOutput | null
      readonly audio: FfmpegRtpOutput | null
    }

/**
 * An optional SECOND output carrying source audio as its own RTP stream,
 * alongside an elementary video sink (which is `-an`). ffmpeg writes the
 * authoritative SDP to `sdpFile`.
 */
export interface FfmpegAudioSidecar {
  readonly codec: FfmpegAudioCodecId
  readonly rtpUrl: string
  readonly sdpFile: string
}

// ---------------------------------------------------------------------------
// The filter graph
// ---------------------------------------------------------------------------

/**
 * An explicit `-filter_complex` graph, for an invocation that combines MORE
 * THAN ONE input into one output — a composite/grid camera being the case this
 * exists for: N decodes, one composition, ONE encode, inside ONE child. Frames
 * never cross a process boundary at frame-rate (D9/D18), so the composition
 * has to happen where the decodes already are.
 *
 * The graph text is the caller's — the builder does not compose, parse or
 * validate it. What the builder owns is the consequence: a graph names its
 * OUTPUT PADS, and those pads are what `-map` selects. Declaring the labels
 * here is what lets the `-map` be DERIVED instead of hardcoded.
 *
 * Input pads are addressed by the input's ORDINAL: `[0:v]` is
 * {@link FfmpegInvocation.input}, `[1:v]` is `extraInputs[0]`, and so on, in
 * the order the builder emits them.
 */
export interface FfmpegFilterGraph {
  /** The `-filter_complex` value, verbatim. */
  readonly graph: string
  /** The graph's VIDEO output pad label, without brackets (e.g. `grid`). */
  readonly videoOutLabel: string
  /**
   * The graph's AUDIO output pad label, without brackets. Absent / `null` ⇒
   * the graph produces no audio and the audio plane is mapped from input 0
   * (`0:a:0?`) like any single-input invocation.
   */
  readonly audioOutLabel?: string | null
}

// ---------------------------------------------------------------------------
// The invocation
// ---------------------------------------------------------------------------

/**
 * The hardware device an ENCODER runs on — a different question from
 * {@link FfmpegInvocation.decodeHwAccel}, and the reason both exist.
 *
 * A software decode can feed a hardware encoder: ffmpeg pushes the frames to
 * the GPU with `hwupload`, and the encode — which is where the CPU actually
 * goes — never touches a core. Tying the two together is what kept this hub on
 * `libx264` while its iGPU sat idle: the node's DECODE preference is `copy`
 * for a good reason (hardware decode hard-fails on a fragile HEVC source) and
 * that preference was deciding the ENCODER too.
 *
 * Declaring it is all-or-nothing by construction: the device option, the
 * upload filter and the encoder are emitted together or not at all, because
 * any two of the three without the third is a child that dies at start-up
 * ("No device available for encoder", "Impossible to convert between the
 * formats").
 */
export interface FfmpegHwEncodeDevice {
  readonly kind: 'vaapi'
  /** DRM render node, e.g. `/dev/dri/renderD128`. */
  readonly renderNode: string
}

export interface FfmpegInvocation {
  readonly logLevel: 'error' | 'warning' | 'info'
  /**
   * A concrete `-hwaccel` backend, the literal `'auto'`, or a software
   * sentinel (`null` / `'none'` / `'copy'`) ⇒ no `-hwaccel` at all.
   * Resolved by `resolveDecodeHwAccel` (see `./hwaccel.js`), which reads the
   * DECODER ADDON's ranking, never the raw kernel resolver's.
   */
  readonly decodeHwAccel: string | null
  /**
   * The device the hardware ENCODER runs on. Absent ⇒ nothing changes: no
   * device option, no upload filter, argv unchanged for every software
   * encode and for every call site that predates this field.
   */
  readonly hwEncodeDevice?: FfmpegHwEncodeDevice
  readonly input: FfmpegInputPlan
  /**
   * Inputs 1..N-1, emitted after {@link input} in this order, each with its own
   * complete input block (`-hwaccel` included — it is per-input, and an option
   * that lands after ITS `-i` is accepted, ignored, and silently software).
   *
   * Absent or empty ⇒ the single-input invocation every existing call site
   * builds, argv unchanged.
   */
  readonly extraInputs?: readonly FfmpegInputPlan[]
  /**
   * The composition, when there is one. Present ⇒ `-filter_complex` is emitted
   * after the last `-i` and the output `-map`s are taken from its declared
   * pads. See {@link FfmpegFilterGraph}.
   */
  readonly filterGraph?: FfmpegFilterGraph | null
  readonly video: FfmpegVideoPlan
  readonly audio: FfmpegAudioPlan
  /** `0` = auto (omit `-threads` and let ffmpeg decide). */
  readonly threadCount: number
  /**
   * `-filter_threads` — the size of libavfilter's OWN slice pool, which
   * `-threads` does not touch.
   *
   * A separate number because it is a separate pool: ffmpeg sizes the filter
   * pool to the core count independently of the codec threads, per graph. On
   * this 20-core hub that is ~15 threads per graph doing nothing measurable on
   * a 320x180-class output, and the container's pid cgroup counts every one of
   * them. Measured on the hub 2026-09-18: a recorder passthrough went 20 → 5
   * threads, a snapshot grab 35 → 4, an egress transcode 62 → 18, with
   * `-threads` and this set together.
   *
   * Omitted when absent, so no shipped argv changes by adding the field.
   */
  readonly filterThreadCount?: number
  /** Consumer output options, emitted verbatim after the encode block. */
  readonly outputArgs: readonly string[]
  readonly sink: FfmpegSink
  readonly audioSidecar?: FfmpegAudioSidecar | null
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

/** `-hide_banner -loglevel <level>` — every ffmpeg site opens with this. */
export function logBannerArgs(level: 'error' | 'warning' | 'info'): string[] {
  return ['-hide_banner', '-loglevel', level]
}

/** `true` when the resolved value means "decode in software" (⇒ no `-hwaccel`). */
export function isSoftwareDecode(decodeHwAccel: string | null): boolean {
  return !decodeHwAccel || decodeHwAccel === 'none' || decodeHwAccel === 'copy'
}

/**
 * Every INPUT option, in order, terminated by `-i <url>`. Nothing may be
 * appended to this list by a caller — that is the whole point of the function.
 */
export function buildInputArgs(input: FfmpegInputPlan, decodeHwAccel: string | null): string[] {
  const args: string[] = []
  if (!isSoftwareDecode(decodeHwAccel)) args.push('-hwaccel', String(decodeHwAccel))
  // AFTER extraArgs so `-hwaccel` stays adjacent to its render node, which is
  // how the pinned argv vectors read it.
  if (input.extraArgs?.length) args.push(...input.extraArgs)
  // Both are INPUT options: after `-i` ffmpeg accepts them without complaint
  // and ignores them, exactly like `-hwaccel`.
  if (input.decodeThreadCount !== undefined && input.decodeThreadCount > 0) {
    args.push('-threads', String(input.decodeThreadCount))
  }
  if (input.analyzeDurationUs !== undefined) {
    args.push('-analyzeduration', String(input.analyzeDurationUs))
  }
  if (input.probeSizeBytes !== undefined) args.push('-probesize', String(input.probeSizeBytes))
  // Before `-i`: an input option, and one ffmpeg silently ignores if it lands
  // after the input it was meant for.
  if (input.lowDelay === true) args.push('-flags', 'low_delay')
  // Before `-i`, like every other input option here.
  if (input.useWallclockTimestamps === true) args.push('-use_wallclock_as_timestamps', '1')

  if (input.fflags?.length) {
    for (const flag of input.fflags) args.push('-fflags', flag)
  }
  if (input.rtspTransport) args.push('-rtsp_transport', input.rtspTransport)
  // Last before `-i`, and all four together: `-f` selects the demuxer and the
  // other three are the only way it can be told what it is reading.
  if (input.rawVideo !== undefined) {
    const raw = input.rawVideo
    args.push(
      '-f',
      'rawvideo',
      '-pix_fmt',
      raw.pixelFormat,
      '-video_size',
      `${String(raw.width)}x${String(raw.height)}`,
      '-framerate',
      String(raw.framerate),
    )
  }
  args.push('-i', input.url)
  return args
}

/**
 * Which stream each output plane is fed from.
 *
 * `null` means **emit no `-map` at all** and let ffmpeg select — which is what
 * a single-input invocation has always done, and the only shape that keeps the
 * shipped argv byte-identical. It is never a synonym for "input 0".
 */
export interface FfmpegStreamMaps {
  readonly video: string | null
  readonly audio: string | null
}

/** The facts a map derives from: how many inputs there are, and the graph. */
export type FfmpegStreamSelection = Pick<FfmpegInvocation, 'extraInputs' | 'filterGraph'>

/**
 * Derive the output `-map` selectors. The three cases, in the order they are
 * decided:
 *
 * 1. **A filter graph** — the picture is the graph's declared video pad, and
 *    the audio is its audio pad when it has one, otherwise input 0's mic. A
 *    graph's output is not addressable any other way.
 * 2. **N inputs, no graph** — map input 0 EXPLICITLY. ffmpeg's own selection
 *    picks the "best" stream across ALL inputs, so the egress would silently
 *    become whichever camera happens to have the largest frame.
 * 3. **One input, no graph** — no `-map`. Anything else would change the argv
 *    of every call site that exists today for no gain.
 */
export function resolveStreamMaps(selection: FfmpegStreamSelection): FfmpegStreamMaps {
  const graph = selection.filterGraph
  if (graph) {
    return {
      video: `[${graph.videoOutLabel}]`,
      audio: graph.audioOutLabel ? `[${graph.audioOutLabel}]` : '0:a:0?',
    }
  }
  if (selection.extraInputs?.length) return { video: '0:v:0', audio: '0:a:0?' }
  return { video: null, audio: null }
}

/** The `-vf` filter args, or `[]` when a consumer `-vf` already claims the slot. */
function buildVideoFilterArgs(
  scale: FfmpegScalePlan | null | undefined,
  outputArgs: readonly string[],
  filterGraph: FfmpegFilterGraph | null | undefined,
  /**
   * `format=nv12,hwupload` when the frames must end up on the GPU for the
   * encoder, empty otherwise. It is always LAST in the chain: everything
   * before it runs on software frames, and nothing can run after the upload.
   */
  hwUpload: string,
): string[] {
  // A simple `-vf` on an output that a complex graph feeds is refused by
  // ffmpeg ("filtergraph was specified for a stream fed from a complex
  // filtergraph"). Dropping the scale here instead would be the silent no-op
  // this file exists to prevent: the plan would say 1280x720 and the child
  // would emit the graph's own size, with nothing saying so. A composition
  // scales INSIDE its graph.
  if (filterGraph) {
    if (scale) {
      throw new Error(
        'FfmpegInvocation: video.scale cannot be combined with a filter graph — ' +
          'scale inside the graph instead (the -vf would feed an output the graph already feeds)',
      )
    }
    if (outputArgs.some((a) => a === '-vf')) {
      throw new Error(
        'FfmpegInvocation: outputArgs carries a -vf while a filter graph feeds the same output — ' +
          'fold the filter into the graph',
      )
    }
    return []
  }
  // A `-vf` the consumer wrote itself owns the chain, upload included: we
  // cannot append to a string we do not understand, and silently dropping the
  // upload would produce a child that dies on its first frame.
  if (outputArgs.some((a) => a === '-vf')) return []
  if (!scale) return hwUpload.length > 0 ? ['-vf', hwUpload] : []
  const suffix = hwUpload.length > 0 ? `,${hwUpload}` : ''
  if (scale.mode === 'exact') return ['-vf', `scale=${scale.width}:${scale.height}${suffix}`]
  return [
    '-vf',
    `scale='min(${scale.width},iw)':'min(${scale.height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2${suffix}`,
  ]
}

/**
 * The upload filter a hardware encode needs, or `''`.
 *
 * Nothing is uploaded when the DECODE already left the frames on the GPU
 * (`-hwaccel vaapi`): they are surfaces already, and uploading a surface is an
 * error rather than a no-op.
 */
function resolveHwUpload(
  device: FfmpegHwEncodeDevice | undefined,
  decodeHwAccel: string | null,
): string {
  if (device === undefined) return ''
  if (!isSoftwareDecode(decodeHwAccel)) return ''
  return 'format=nv12,hwupload'
}

/** Rate-control args for an encode plan. */
function buildRateControlArgs(video: FfmpegVideoEncodePlan): string[] {
  const kbps = video.bitrateKbps
  if (kbps === undefined) return []
  const rc: FfmpegRateControl = video.rateControl ?? {
    kind: 'cap',
    vbvSeconds: 2,
  }
  const bufsize = Math.max(1, Math.round(kbps * rc.vbvSeconds))
  const target = rc.kind === 'cbr' ? ['-b:v', `${kbps}k`] : []
  return [...target, '-maxrate', `${kbps}k`, '-bufsize', `${bufsize}k`]
}

/** The whole video block (`-vf` … `-c:v` … knobs), after `-i`. */
export function buildVideoArgs(
  video: FfmpegVideoPlan,
  outputArgs: readonly string[],
  filterGraph?: FfmpegFilterGraph | null,
  /** Set when the encoder runs on a GPU — see {@link FfmpegHwEncodeDevice}. */
  hwEncode?: { readonly device: FfmpegHwEncodeDevice; readonly decodeHwAccel: string | null },
): string[] {
  if (video.kind === 'raw') {
    // Same refusal as `copy` above, for the same reason: a simple `-vf` on an
    // output a complex graph already feeds is rejected by ffmpeg, and dropping
    // it here would be the silent no-op this file exists to prevent.
    if (filterGraph && video.filter !== undefined) {
      throw new Error(
        'FfmpegInvocation: video.filter cannot be combined with a filter graph — ' +
          'fold the filter into the graph',
      )
    }
    return [
      ...(video.filter !== undefined ? ['-vf', video.filter] : []),
      '-c:v',
      'rawvideo',
      '-pix_fmt',
      video.pixelFormat,
      ...(video.fps !== undefined ? ['-r', String(video.fps)] : []),
    ]
  }
  if (video.kind === 'copy') {
    // A composed picture does not exist in any input's bitstream — there is
    // nothing to copy. ffmpeg fails the child at start-up; saying so here
    // names the plan that is wrong instead of the process that died.
    if (filterGraph) {
      throw new Error(
        'FfmpegInvocation: a filter graph produces a NEW picture, so video.kind must be `encode`',
      )
    }
    return ['-c:v', 'copy', ...(video.bitstreamFilter ? ['-bsf:v', video.bitstreamFilter] : [])]
  }
  const hwUpload =
    hwEncode === undefined ? '' : resolveHwUpload(hwEncode.device, hwEncode.decodeHwAccel)
  if (hwEncode !== undefined && filterGraph) {
    // The graph produces the picture, so the upload has to be the graph's last
    // node — appended here it would feed an output the graph already feeds,
    // which ffmpeg refuses. Saying so names the plan that is wrong instead of
    // the process that died.
    throw new Error(
      'FfmpegInvocation: a hardware encode fed by a filter graph must upload INSIDE the graph — ' +
        'hwEncodeDevice cannot be combined with filterGraph',
    )
  }
  const args = [
    ...buildVideoFilterArgs(video.scale, outputArgs, filterGraph, hwUpload),
    '-c:v',
    video.encoder,
  ]
  if (video.preset !== undefined) args.push('-preset', video.preset)
  if (video.tune !== undefined) args.push('-tune', video.tune)
  // x264 only: the knob belongs to that encoder, and naming it for a hardware
  // encoder that does not have it would be a flag the child rejects.
  if (video.singleSlicePerFrame === true && video.encoder === 'libx264') {
    args.push('-x264-params', 'sliced-threads=0')
  }
  if (video.profile !== undefined) args.push('-profile:v', video.profile)
  if (video.level !== undefined) args.push('-level', video.level)
  if (video.pixelFormat !== undefined) args.push('-pix_fmt', video.pixelFormat)
  if (video.fps !== undefined) args.push('-r', String(video.fps))
  if (video.gopFrames !== undefined) args.push('-g', String(video.gopFrames))
  if (video.forceKeyFramesSeconds !== undefined) {
    args.push('-force_key_frames', `expr:gte(t,n_forced*${video.forceKeyFramesSeconds})`)
  }
  if (video.bf !== undefined) args.push('-bf', String(video.bf))
  args.push(...buildRateControlArgs(video))
  if (video.bitstreamFilter !== undefined) args.push('-bsf:v', video.bitstreamFilter)
  return args
}

/** The whole audio block, after `-i`. */
export function buildAudioArgs(audio: FfmpegAudioPlan): string[] {
  if (audio.kind === 'none') return ['-an']
  if (audio.kind === 'copy') return ['-c:a', 'copy']
  const args: string[] = []
  if (audio.filter !== undefined) args.push('-af', audio.filter)
  args.push('-c:a', AUDIO_ENCODER_BY_CODEC[audio.codec])
  if (audio.application !== undefined) args.push('-application', audio.application)
  if (audio.frameDurationMs !== undefined)
    args.push('-frame_duration', String(audio.frameDurationMs))
  if (audio.globalHeader === true) args.push('-flags', '+global_header')
  if (audio.sampleRateHz !== undefined) args.push('-ar', String(audio.sampleRateHz))
  if (audio.bitrateKbps !== undefined) args.push('-b:a', `${audio.bitrateKbps}k`)
  if (audio.vbvBufferKbits !== undefined) args.push('-bufsize', `${audio.vbvBufferKbits}k`)
  if (audio.channels !== undefined) args.push('-ac', String(audio.channels))
  return args
}

/** RTP output-leg args (`-payload_type`, `-ssrc`, `-sdp_file`, `-f rtp <url>`). */
function buildRtpOutputArgs(out: FfmpegRtpOutput): string[] {
  const args: string[] = []
  if (out.payloadType !== undefined) args.push('-payload_type', String(out.payloadType))
  if (out.ssrc !== undefined) args.push('-ssrc', String(out.ssrc))
  if (out.sdpFile !== undefined) args.push('-sdp_file', out.sdpFile)
  args.push('-f', 'rtp', out.url)
  return args
}

/** `true` when the sink is a raw elementary bytestream that cannot mux audio. */
function isElementaryVideoSink(sink: FfmpegSink): boolean {
  return sink.kind === 'stdout' && (sink.container === 'h264' || sink.container === 'hevc')
}

/**
 * The fragmented-MP4 muxer flags, in the order the recorder has proven them
 * (`recorder/addon/ffmpeg-args.ts` passes the same `movflags` string through
 * `-segment_format_options`, across every vendor in the fleet):
 *
 * - `frag_keyframe` — cut a fragment at each key frame, so every fragment
 *   opens on a sync sample. HKSV's whole requirement.
 * - `empty_moov` — write `ftyp`+`moov` up front with no samples in it, which
 *   is what makes the head a standalone INITIALISATION segment.
 * - `default_base_moof` — fragment offsets are self-relative, so a fragment is
 *   demuxable without the bytes that preceded it. D31's byte-range read path
 *   depends on exactly this property of the recorder's segments.
 */
const FMP4_MOVFLAGS = '+frag_keyframe+empty_moov+default_base_moof'

/**
 * The terminal sink args for every non-`rtp-outputs` sink. Exhaustive over the
 * union so a new member cannot fall through to `['-f', container, 'pipe:1']`,
 * which is what a plain `container` read would have done for `mp4` — a valid
 * argv that writes a NON-fragmented, unseekable-to-a-pipe MP4 and produces one
 * unusable byte stream.
 */
function buildStdoutOrRtspSinkArgs(sink: FfmpegSink): string[] {
  if (sink.kind === 'rtsp-listen') {
    return ['-f', 'rtsp', '-rtsp_transport', 'tcp', '-rtsp_flags', 'listen', sink.url]
  }
  if (sink.kind === 'rtp-outputs') return []
  return sink.container === 'mp4' ? buildFmp4SinkArgs(sink) : ['-f', sink.container, 'pipe:1']
}

/**
 * How far BELOW the negotiated fragment length `-min_frag_duration` is set.
 *
 * `-min_frag_duration` refuses to cut before that much media has accumulated,
 * and then waits for the next key frame. Set to exactly `fragmentMs`, the
 * commonest camera configuration in existence — a key-frame grid EQUAL to the
 * requested fragment length — lands the deadline on the same instant as the key
 * frame, loses the race, and skips to the following one: **every fragment comes
 * out at twice the requested length.**
 *
 * Measured on the live fleet 2026-08-07, camera 101, `-c:v copy` (D84):
 *
 * | slot | GOP | `-min_frag_duration` | median gap |
 * | --- | --- | --- | --- |
 * | 1280×720 | 40 f @ 10 fps = 4.0 s | 4000 ms | **7944 ms** |
 * | 1280×720 | 40 f @ 10 fps = 4.0 s | 3600 ms | 3973 ms |
 * | 3840×2160 | 100 f @ 25 fps = 4.0 s | 4000 ms | 8042 ms |
 * | 3840×2160 | 100 f @ 25 fps = 4.0 s | 3600 ms | 3998 ms |
 *
 * A doubled fragment is not a cosmetic overshoot: HKSV requires every fragment
 * to be no longer than the length the controller SELECTED, so the shipped-but-
 * inert phase-1 sink would have violated the contract on its first real clip.
 *
 * 10 % is chosen against the two failures either side of it. Too small and
 * ordinary jitter (measured spread 3953-4096 ms) re-loses the race; too large
 * and a source with a key frame slightly EARLY than the grid gets cut there,
 * yielding a short fragment for no reason.
 */
const FMP4_MIN_FRAG_MARGIN = 0.9

/** `-movflags … -min_frag_duration <us> -f mp4 pipe:1`. */
function buildFmp4SinkArgs(sink: FfmpegFmp4Sink): string[] {
  return [
    '-movflags',
    FMP4_MOVFLAGS,
    // Microseconds — the muxer's unit. Rounded rather than truncated so a
    // caller's millisecond figure is never quietly shortened.
    '-min_frag_duration',
    String(Math.max(0, Math.round(sink.fragmentMs * FMP4_MIN_FRAG_MARGIN * 1000))),
    '-f',
    'mp4',
    'pipe:1',
  ]
}

/**
 * A second output mapping source audio to RTP-over-UDP. `0:a:0?` makes the
 * audio optional so a source with no audio skips it instead of failing the
 * whole invocation.
 */
function buildAudioSidecarArgs(sidecar: FfmpegAudioSidecar): string[] {
  // The sidecar is a camera mic like any other, so it takes the same preset
  // (bitrate / sample rate / channels) rather than a bare `-c:a <enc>`.
  const plan =
    sidecar.codec === 'pcma'
      ? ({
          kind: 'encode',
          codec: 'pcma',
          sampleRateHz: 8000,
          channels: 1,
        } as const)
      : AUDIO_PRESETS[sidecar.codec]
  return [
    '-map',
    '0:a:0?',
    ...buildAudioArgs(plan),
    ...buildRtpOutputArgs({ url: sidecar.rtpUrl, sdpFile: sidecar.sdpFile }),
  ]
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Assemble the full ffmpeg argument list. Layout:
 *
 *   -hide_banner -loglevel <level>
 *   [-hwaccel <backend|auto>]        ─┐ INPUT options — strictly before -i.
 *   [<input.extraArgs>]               │
 *   [-fflags <flag>…]                 │
 *   [-rtsp_transport tcp]             │
 *   -i <url>                         ─┘ …repeated per extraInput
 *   [-filter_complex <graph>]         ─ global, after the LAST -i
 *   [-map <video>]  <video block>  <threads>  ─┐ OUTPUT options.
 *   [-map <audio>]  <audio block>              │
 *   <consumer outputArgs verbatim>             │
 *   <sink>                                    ─┘ terminal
 *
 * The `-map`s are DERIVED (see {@link resolveStreamMaps}), never constants:
 * one input with no graph emits none at all, which is why the argv of every
 * call site that predates the N-input extension is unchanged to the byte.
 *
 * {@link FfmpegInvocation.audioSidecar} is the one map that stays literal
 * (`0:a:0?`): the sidecar is defined as the SOURCE's microphone on its own RTP
 * output, not as whatever the main output happens to carry.
 */
/** The hardware-encode context for this invocation, or `undefined`. */
function hwEncodeFor(
  inv: FfmpegInvocation,
): { readonly device: FfmpegHwEncodeDevice; readonly decodeHwAccel: string | null } | undefined {
  return inv.hwEncodeDevice === undefined
    ? undefined
    : { device: inv.hwEncodeDevice, decodeHwAccel: inv.decodeHwAccel }
}

export function buildFfmpegArgs(inv: FfmpegInvocation): string[] {
  const graph = inv.filterGraph ?? null
  const head = [
    ...logBannerArgs(inv.logLevel),
    // GLOBAL, and therefore before the inputs: `-vaapi_device` initialises the
    // device the encoder will run on. After an `-i` ffmpeg takes it as an
    // input option, accepts it, and the encoder then has no device.
    ...(inv.hwEncodeDevice !== undefined ? ['-vaapi_device', inv.hwEncodeDevice.renderNode] : []),
    // Every input gets its OWN complete input block. `-hwaccel` binds to the
    // `-i` that follows it, so N inputs means N of them.
    ...buildInputArgs(inv.input, inv.decodeHwAccel),
    ...(inv.extraInputs ?? []).flatMap((extra) => buildInputArgs(extra, inv.decodeHwAccel)),
    // `-filter_complex` is a global option and must follow the last `-i`: it
    // addresses inputs by ordinal, so the inputs have to exist first.
    ...(graph ? ['-filter_complex', graph.graph] : []),
  ]
  const threadArgs = [
    ...(inv.threadCount > 0 ? ['-threads', String(inv.threadCount)] : []),
    ...(inv.filterThreadCount !== undefined && inv.filterThreadCount > 0
      ? ['-filter_threads', String(inv.filterThreadCount)]
      : []),
  ]
  const maps = resolveStreamMaps(inv)
  const videoMapArgs = maps.video ? ['-map', maps.video] : []
  const audioMapArgs = maps.audio ? ['-map', maps.audio] : []

  if (inv.sink.kind === 'rtp-outputs') {
    // Two separately-mapped outputs. Each leg is explicitly muted on the other
    // plane so ffmpeg never guesses which stream belongs where. Both legs are
    // ALWAYS explicit here — a `null` map from the derivation means "ffmpeg's
    // own selection", which these legs cannot use, so they fall back to input
    // 0. That fallback is the old hardcoded value, now a stated default.
    const videoLeg = inv.sink.video
      ? [
          '-an',
          '-map',
          maps.video ?? '0:v:0',
          ...buildVideoArgs(inv.video, inv.outputArgs, graph, hwEncodeFor(inv)),
          ...threadArgs,
          ...inv.outputArgs,
          ...buildRtpOutputArgs(inv.sink.video),
        ]
      : []
    const audioLeg = inv.sink.audio
      ? [
          '-vn',
          '-map',
          maps.audio ?? '0:a:0?',
          ...buildAudioArgs(inv.audio),
          ...buildRtpOutputArgs(inv.sink.audio),
        ]
      : []
    return [...head, ...videoLeg, ...audioLeg]
  }

  const mutedAudio = isElementaryVideoSink(inv.sink) || inv.audio.kind === 'none'
  const audioArgs = isElementaryVideoSink(inv.sink) ? ['-an'] : buildAudioArgs(inv.audio)

  return [
    ...head,
    ...videoMapArgs,
    ...buildVideoArgs(inv.video, inv.outputArgs, graph, hwEncodeFor(inv)),
    ...threadArgs,
    // No `-map` for a plane that is muted: `-an` and a mapped audio stream in
    // the same output is a contradiction ffmpeg resolves by ignoring one.
    ...(mutedAudio ? [] : audioMapArgs),
    ...audioArgs,
    ...inv.outputArgs,
    ...buildStdoutOrRtspSinkArgs(inv.sink),
    ...(inv.audioSidecar ? buildAudioSidecarArgs(inv.audioSidecar) : []),
  ]
}

// ---------------------------------------------------------------------------
// The EncodeProfile adapter
// ---------------------------------------------------------------------------

/**
 * Hardware ENCODER ids per decode-hwaccel backend — a static, deterministic
 * map (the same shape the reference NVR uses: platform → encoder, no probe).
 */
const ENCODER_IDS_BY_BACKEND: Readonly<
  Record<string, { readonly h264: FfmpegVideoEncoderId; readonly h265: FfmpegVideoEncoderId }>
> = {
  videotoolbox: { h264: 'h264_videotoolbox', h265: 'hevc_videotoolbox' },
  vaapi: { h264: 'h264_vaapi', h265: 'hevc_vaapi' },
  qsv: { h264: 'h264_qsv', h265: 'hevc_qsv' },
  cuda: { h264: 'h264_nvenc', h265: 'hevc_nvenc' },
  nvdec: { h264: 'h264_nvenc', h265: 'hevc_nvenc' },
  amf: { h264: 'h264_amf', h265: 'hevc_amf' },
}

/**
 * The hardware encoder for a target codec on `backend`, or the software one.
 * `'auto'` is NOT a backend identity (it is an instruction to ffmpeg), so it
 * maps to software encoding.
 */
export function pickVideoEncoder(
  target: 'h264' | 'h265',
  backend: string | null,
  useHardware: boolean,
): FfmpegVideoEncoderId {
  const software: FfmpegVideoEncoderId = target === 'h264' ? 'libx264' : 'libx265'
  if (!useHardware || backend === null || isSoftwareDecode(backend) || backend === 'auto') {
    return software
  }
  const ids = ENCODER_IDS_BY_BACKEND[backend.toLowerCase()]
  if (!ids) return software
  return target === 'h264' ? ids.h264 : ids.h265
}

/** Map an `EncodeProfile.audio` to an audio plan. */
export function audioPlanFromEncodeProfile(audio: AudioEncode): FfmpegAudioPlan {
  if (audio === 'passthrough') return { kind: 'none' }
  if (audio.codec === 'copy') return { kind: 'copy' }
  return {
    kind: 'encode',
    codec: audio.codec,
    ...(audio.bitrateKbps !== undefined ? { bitrateKbps: audio.bitrateKbps } : {}),
    ...(audio.sampleRateHz !== undefined ? { sampleRateHz: audio.sampleRateHz } : {}),
    ...(audio.channels !== undefined ? { channels: audio.channels } : {}),
  }
}

export interface EncodeProfileInvocationInput {
  readonly profile: EncodeProfile
  /** The SOURCE's video codec — drives the smart-copy decision. */
  readonly sourceCodec: 'h264' | 'h265'
  readonly sourceUrl: string
  readonly sink: FfmpegSink
  readonly decodeHwAccel: string | null
  /**
   * Defeat smart-copy. A DERIVED stream always applies its profile — applying
   * it is its entire reason to exist — so it re-encodes even when the source
   * already speaks the target codec. A `copy` profile still copies.
   */
  readonly forceReencode?: boolean
  /** Select the hardware encoder for {@link decodeHwAccel}'s backend. */
  readonly hardwareEncoders?: boolean
  readonly logLevel?: 'error' | 'warning' | 'info'
  readonly threadCount?: number
  readonly audioSidecar?: FfmpegAudioSidecar | null
  /**
   * How the encoder is bounded. `EncodeProfile` carries a bitrate but not the
   * WINDOW it is enforced over, and the window is the difference between a
   * HomeKit stream that fits its per-second budget and one that overshoots on
   * every key frame. Absent ⇒ the relaxed two-second default a browser wants.
   *
   * The three overlays below are on the INVOCATION rather than on
   * `EncodeProfile` on purpose: they are consumer-protocol facts
   * (`acquireEgressTranscode` exposes each as its own named request field),
   * while `EncodeProfile` is the operator-facing shape a derived-stream editor
   * writes. Folding them into the profile would put ffmpeg detail in front of
   * an operator who has no way to judge it.
   */
  readonly rateControl?: FfmpegRateControl
  /** `-bsf:v` — `dump_extra` for a consumer that negotiates its own SDP. */
  readonly bitstreamFilter?: string
  /** `-pix_fmt`. */
  readonly pixelFormat?: string
  /**
   * `-force_key_frames` on a fixed grid — see
   * {@link FfmpegVideoEncodePlan.forceKeyFramesSeconds}. An overlay like the
   * three above rather than an `EncodeProfile` field: it is a CONSUMER-protocol
   * fact (an fMP4 fragment length the consumer negotiated), not something an
   * operator authoring a derived stream can judge.
   *
   * Applies only to the encode branch. On a smart COPY there is no encoder to
   * instruct, and the caller — not this adapter — has to decide whether a
   * source-dictated GOP is acceptable, because only the caller knows what it
   * promised its consumer.
   */
  readonly forceKeyFramesSeconds?: number
}

/**
 * Adapt an `EncodeProfile` (the operator/consumer-facing shape) into an
 * {@link FfmpegInvocation}. This is the ONLY bridge between the two models —
 * a second one is how the repo grew two argv builders that disagreed about
 * hardware.
 *
 * Smart video copy: when the source already speaks the requested codec the
 * encode block is elided entirely and ffmpeg runs as a re-muxer on the video
 * plane. Width / height / fps / bitrate in the profile are a downstream BUDGET,
 * not a forced rescale.
 */
export function invocationFromEncodeProfile(input: EncodeProfileInvocationInput): FfmpegInvocation {
  const v = input.profile.video
  const shouldCopy =
    v.codec === 'copy' || (input.forceReencode !== true && v.codec === input.sourceCodec)
  const scale: FfmpegScalePlan | null =
    v.width !== undefined && v.height !== undefined
      ? { mode: 'fit', width: v.width, height: v.height }
      : null
  const target: 'h264' | 'h265' = v.codec === 'h265' ? 'h265' : 'h264'

  const video: FfmpegVideoPlan = shouldCopy
    ? {
        kind: 'copy',
        // A `-bsf:v` survives a smart copy: `dump_extra` exists precisely to
        // re-inline parameter sets a REMUX would otherwise leave in extradata,
        // which is the copy branch's whole problem.
        ...(input.bitstreamFilter !== undefined ? { bitstreamFilter: input.bitstreamFilter } : {}),
      }
    : {
        kind: 'encode',
        encoder: pickVideoEncoder(target, input.decodeHwAccel, input.hardwareEncoders === true),
        scale,
        ...(v.preset !== undefined ? { preset: v.preset } : {}),
        ...(v.tune !== undefined ? { tune: v.tune } : {}),
        ...(v.singleSlicePerFrame !== undefined
          ? { singleSlicePerFrame: v.singleSlicePerFrame }
          : {}),
        ...(v.profile !== undefined ? { profile: v.profile } : {}),
        ...(v.level !== undefined ? { level: v.level } : {}),
        ...(input.pixelFormat !== undefined ? { pixelFormat: input.pixelFormat } : {}),
        ...(v.fps !== undefined ? { fps: v.fps } : {}),
        ...(v.gopFrames !== undefined ? { gopFrames: v.gopFrames } : {}),
        ...(input.forceKeyFramesSeconds !== undefined
          ? { forceKeyFramesSeconds: input.forceKeyFramesSeconds }
          : {}),
        ...(v.bf !== undefined ? { bf: v.bf } : {}),
        ...(v.bitrateKbps !== undefined ? { bitrateKbps: v.bitrateKbps } : {}),
        ...(input.rateControl !== undefined ? { rateControl: input.rateControl } : {}),
        ...(input.bitstreamFilter !== undefined ? { bitstreamFilter: input.bitstreamFilter } : {}),
      }

  return {
    logLevel: input.logLevel ?? 'error',
    decodeHwAccel: input.decodeHwAccel,
    input: {
      url: input.sourceUrl,
      rtspTransport: 'tcp',
      // The consumer joins the restream mid-GOP, so the first decoded frames
      // reference pictures ffmpeg never saw. Drop them until it syncs to a
      // clean IDR rather than encoding a corrupt frame.
      fflags: ['+discardcorrupt'],
      ...(input.profile.inputArgs?.length ? { extraArgs: input.profile.inputArgs } : {}),
    },
    video,
    audio: audioPlanFromEncodeProfile(input.profile.audio),
    threadCount: input.threadCount ?? 0,
    outputArgs: input.profile.outputArgs ?? [],
    sink: input.sink,
    ...(input.audioSidecar !== undefined ? { audioSidecar: input.audioSidecar } : {}),
  }
}
