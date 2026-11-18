/**
 * Derived-stream transcode argv.
 *
 * A derived stream re-encodes an existing camera stream (a broker loopback
 * restream) into a distinct geometry/bitrate/codec variant. It builds its argv
 * through the ONE builder in `@camstack/types` — the same one the WebRTC
 * transcode leg, the broker transcode pool and HomeKit use. There is no second
 * builder; the previous `buildTranscodeFfmpegArgs` in `webrtc/session.ts` was
 * deleted, and with it the two hacks this module needed to bend it into shape:
 * a sink-retargeting string surgery on the tail of the arg list, and a fake
 * `inputFormat` chosen only to defeat smart-copy.
 *
 * ## The audio rule, and the outage that wrote it
 *
 * A derived stream is a self-contained MPEG-TS, so its audio must travel
 * IN-BAND — `passthrough` (`-an`, right for WebRTC, where werift carries audio
 * out of band) silently drops the track. That was fixed on 2026-07-17 by
 * remapping `passthrough` → `-c:a copy`, and the track stayed missing anyway,
 * because a copy has to survive TWO hops and it only clears the first:
 *
 *   1. the MPEG-TS MUXER. Measured with ffmpeg 7.1: a `pcm_mulaw` track copied
 *      into `-f mpegts` does not fail the invocation. ffmpeg logs
 *      `Stream 1, codec pcm_mulaw, is muxed as a private data stream and may
 *      not be recognized upon reading` and writes stream_type `0x06` — which
 *      is why the derived stream looked perfectly healthy: video never
 *      stopped;
 *   2. {@link MpegTsDemux}, which adopts an elementary audio PID only for
 *      stream_type `0x0f` (AAC) or `0x03`/`0x04` (MP2). `0x06` is not audio to
 *      it, so no audio packet was ever forwarded, `onAudioInfo` never fired,
 *      the derived broker never learned it had audio, and its probe read
 *      `audio: null` forever.
 *
 * Every camera in this fleet speaks G.711 (PCMU/PCMA), so the copy could never
 * work for any of them: no `derived:*` stream has EVER carried audio, and
 * camera 108 — whose `low` (motion, and therefore audio) profile is mapped to
 * a derived stream — went silent the day it was remapped.
 *
 * So the carrier decides, explicitly and loudly, not the profile: source audio
 * is COPIED when it is already AAC, and RE-ENCODED to AAC otherwise (including
 * when the source codec is unknown — the safe direction, since an unknown that
 * guesses `copy` mutes the camera). The decision is returned to the caller so
 * it can be logged per camera; it is never taken silently.
 */
import {
  type AudioEncode,
  type DerivedEffectiveEncodeStats,
  buildFfmpegArgs,
  type EncodeProfile,
  invocationFromEncodeProfile,
  type VideoEncode,
} from '@camstack/types'

/**
 * Audio codecs that survive BOTH hops of the derived carrier untouched: a
 * standard MPEG-TS stream type AND a stream type {@link MpegTsDemux} adopts.
 *
 * AAC only, deliberately. MP2 clears both hops as a container matter, but the
 * broker's push-audio path has no MP2 decode (`StreamBroker.pushAudioInfo` →
 * `buildAudioCodecSessionConfigFromPush` handles `aac`/`opus`), so a copied
 * MP2 track would arrive as an announced-but-undecodable stream — a second way
 * to be silent, with a track descriptor to make it look fine.
 */
const TS_COPYABLE_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac'])

/**
 * The AAC re-encode used when the source cannot be copied. Mono, and
 * deliberately WITHOUT a forced sample rate: a G.711 camera mic is 8 kHz, and
 * upsampling it to the 48 kHz camera preset would spend bitrate on nothing.
 * ffmpeg's native AAC encoder accepts 8 kHz, the ADTS header carries whatever
 * rate came out, and `parseAdtsAudioParams` reads it back for the broker.
 */
/**
 * One second of GOP at the fleet cadence, used when the derived profile names
 * neither gopFrames nor fps. Matches BASE_LIVE_EGRESS_PROFILE's intent.
 */
const DERIVED_DEFAULT_GOP_FRAMES = 25

/**
 * No B-frames, ever, unless the profile asks for them by name.
 *
 * A derived stream's carrier is MPEG-TS → {@link MpegTsDemux} → the broker →
 * RTP (an RTSP restream to the recorder, a WebRTC leg to a viewer). Every hop
 * has to carry the reorder delay and RTP has no field for it at all — so
 * reordering costs latency on the whole chain and buys compression nobody
 * asked for at 640x360.
 */
const DERIVED_DEFAULT_BF = 0

/**
 * The encode preset and tune the carrier pins when the profile names neither.
 *
 * `veryfast` + `zerolatency` is `BASE_LIVE_EGRESS_PROFILE`'s pairing, and it is
 * the pairing that removes x264's lookahead: `preset medium` carries
 * `rc-lookahead=40`, which at 25 fps is 1.6 SECONDS the encoder holds before it
 * emits anything. See this module's `withCarrierDefaults` for the measurement.
 */
const DERIVED_DEFAULT_PRESET = 'veryfast'
const DERIVED_DEFAULT_TUNE = 'zerolatency'

/**
 * The bit density a derived tier is capped at, expressed as the shared
 * live-egress profile it is scaled from: `BASE_LIVE_EGRESS_PROFILE` spends
 * 2500 kbps on 1280x720 at 25 fps. Scaling that per pixel-per-second gives
 * 625 kbps at 640x360@25 — and a 10 s segment of 625 kbps is ~780 KB, well
 * inside the scrub's whole-segment ceiling (D163: 4 MB hard cap,
 * `scrubWholeSegmentCeilingBytes`; it was 1.5 MB when this was tuned).
 */
const DERIVED_BITRATE_REFERENCE_KBPS = 2500
const DERIVED_BITRATE_REFERENCE_PIXELS_PER_SECOND = 1280 * 720 * 25

/**
 * The ABR target as a fraction of the cap. A cap alone leaves x264 in CRF 23,
 * which wants far more than the cap on a binding tier and crushes the KEYFRAME
 * (reproduced at 400 kbps on 720p: IDR QP 48–57, PSNR 34 to 23 dB). A target
 * at 0.8 of the cap measured flat ~35.8 dB across the IDR, 364 kbps average.
 */
const DERIVED_ABR_TARGET_FRACTION = 0.8

/**
 * The lowest bitrate WE accept for a geometry, as a fraction of the reference
 * density above (so it follows pixels x fps). 720p@20 floors at 800 kbps; the
 * 400 kbps that blurred it is below. An explicit lower value is raised.
 */
const DERIVED_BITRATE_FLOOR_FRACTION = 0.4
/** Absolute floor, so a tiny geometry never derives a meaningless bitrate. */
const DERIVED_BITRATE_FLOOR_MIN_KBPS = 150

/**
 * A requested fps is only clamped when it exceeds the measured source fps by
 * more than this factor, so a 19.8 fps measurement never "clamps" a 20 request.
 */
const DERIVED_FPS_CLAMP_TOLERANCE = 1.05

const DERIVED_AAC_RECODE: AudioEncode = { codec: 'aac', channels: 1 }

/** What the derived carrier decided to do with the SOURCE's audio track. */
export type DerivedAudioDecision =
  /** The profile named an explicit encode (not "carry the source") — honoured verbatim. */
  | { readonly kind: 'profile' }
  /** Source audio already rides an MPEG-TS end to end → `-c:a copy`. */
  | { readonly kind: 'copy'; readonly sourceCodec: string }
  /**
   * Source audio cannot ride an MPEG-TS by copy → re-encoded to AAC. This is
   * an EXPLICIT, reported downgrade, never a silent one. `sourceCodec` is
   * `null` when the source's codec was not observable at spawn time.
   */
  | { readonly kind: 'recode-aac'; readonly sourceCodec: string | null }

/** The audio the derived transcode will emit, plus why. */
export interface DerivedAudioPlan {
  readonly audio: AudioEncode
  readonly decision: DerivedAudioDecision
}

/** `true` when this profile audio means "carry whatever the source has". */
function wantsSourceAudio(audio: AudioEncode): boolean {
  return audio === 'passthrough' || audio.codec === 'copy'
}

/**
 * Decide the derived stream's audio from the profile's intent and the SOURCE's
 * observed codec. Pure; see this module's header for why `copy` is not the
 * default answer to "carry the source's audio".
 *
 * `sourceAudioCodec` is matched case-insensitively (`BrokerStats.audio.codec`
 * is upper-cased, SDP spellings are not).
 */
export function resolveDerivedAudio(
  profileAudio: AudioEncode,
  sourceAudioCodec?: string | null,
): DerivedAudioPlan {
  if (!wantsSourceAudio(profileAudio)) {
    return { audio: profileAudio, decision: { kind: 'profile' } }
  }
  const observed = sourceAudioCodec?.toLowerCase() ?? null
  if (observed !== null && TS_COPYABLE_AUDIO_CODECS.has(observed)) {
    return { audio: { codec: 'copy' }, decision: { kind: 'copy', sourceCodec: observed } }
  }
  return { audio: DERIVED_AAC_RECODE, decision: { kind: 'recode-aac', sourceCodec: observed } }
}

/** What the SOURCE broker has measured of its own video cadence. */
export interface DerivedSourceCadence {
  /** Observed input frames per second; `null`/`0` when nothing was measured. */
  readonly fps: number | null
  /** Observed milliseconds between two IDRs; `null`/`0` when unknown. */
  readonly idrIntervalMs: number | null
}

/** The cadence a derived encode runs at, and the numbers behind it. */
export interface DerivedCadence {
  readonly fpsMode: 'cfr' | 'passthrough'
  /** The fps the profile asked for; `null` when it named none. */
  readonly requestedFps: number | null
  /** `true` when the request exceeded the source and the source cadence won. */
  readonly fpsClamped: boolean
  /** Frame rate the GOP is counted in; `null` when nothing names one. */
  readonly outputFps: number | null
  readonly gopFrames: number
  readonly vbvSeconds: number
}

/** IDR interval assumed when the source's own is unknown. */
const DERIVED_FALLBACK_IDR_SECONDS = 2
const DERIVED_MIN_IDR_SECONDS = 1
const DERIVED_MAX_IDR_SECONDS = 10
const DERIVED_MIN_VBV_SECONDS = 2

function positive(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Resolve the cadence of a derived encode.
 *
 * - **Frame rate.** A profile `fps` is explicit intent (`cfr`). Without one the
 *   source's cadence is passed through: ffmpeg is never asked to duplicate a
 *   20 fps source up to a guessed 30, which put an IDR every second on a
 *   400 kbps cap and starved the VBV on each one (the visible flicker).
 * - **GOP.** An explicit `gopFrames` wins. Otherwise, with a measured source,
 *   the source's own IDR interval (else 2 s) in OUTPUT frames. With nothing
 *   measured the legacy second-of-frames stays.
 * - **VBV.** In cap mode the buffer covers the whole GOP, so one IDR cannot
 *   starve it.
 */
export function resolveDerivedCadence(
  video: VideoEncode,
  source: DerivedSourceCadence | undefined,
): DerivedCadence {
  const sourceFps = positive(source?.fps)
  const requestedFps = positive(video.fps)
  // Never upsample: a request above the source would only duplicate frames
  // (2 of 3 at 60 from 20) and spend the bit budget on them.
  const fpsClamped =
    requestedFps !== null &&
    sourceFps !== null &&
    requestedFps > sourceFps * DERIVED_FPS_CLAMP_TOLERANCE
  const outputFps = fpsClamped ? sourceFps : (requestedFps ?? sourceFps)
  const observed = sourceFps !== null
  const idrSeconds = Math.min(
    DERIVED_MAX_IDR_SECONDS,
    Math.max(
      DERIVED_MIN_IDR_SECONDS,
      (positive(source?.idrIntervalMs) ?? DERIVED_FALLBACK_IDR_SECONDS * 1000) / 1000,
    ),
  )
  const gopFrames =
    video.gopFrames ??
    (observed && outputFps !== null
      ? Math.max(1, Math.round(outputFps * idrSeconds))
      : (requestedFps ?? DERIVED_DEFAULT_GOP_FRAMES))
  const gopSeconds = gopFrames / (outputFps ?? DERIVED_DEFAULT_GOP_FRAMES)
  return {
    // A clamped request follows the source cadence (no `-r`), like no request.
    fpsMode: video.fps !== undefined && !fpsClamped ? 'cfr' : 'passthrough',
    requestedFps,
    fpsClamped,
    outputFps,
    gopFrames,
    vbvSeconds: Math.max(DERIVED_MIN_VBV_SECONDS, Math.ceil(gopSeconds * 10) / 10),
  }
}

export interface DerivedTranscodeArgsInput {
  readonly profile: EncodeProfile
  /** The source broker's measured cadence; absent keeps the legacy defaults. */
  readonly sourceCadence?: DerivedSourceCadence
  /** The source picture size; lets a height-only profile scale its bitrate and floor. */
  readonly sourceResolution?: DerivedSourceResolution
  /** The source's broker RTSP loopback — this transcode's `-i`. */
  readonly loopbackUrl: string
  /**
   * `-hwaccel` for the DECODE half. Defaults to software, and that is what the
   * derived feeder passes today.
   *
   * The reason recorded here was wrong, and it mattered: `-hwaccel vaapi`
   * inside the stream-broker runner failed to create a device (ffmpeg
   * `code=244`, measured 2026-08-07) NOT because the two runners were
   * competing for one, but because they ran different BINARIES — the broker's
   * had no VAAPI compiled in, so `av_hwdevice_ctx_alloc` returned NULL and
   * fftools printed `-12 … Cannot allocate memory`, which reads as a shortage
   * and is a build property (D536). The caller now asks the binary before
   * resolving a backend, so a trusted value can actually arrive here.
   */
  readonly decodeHwAccel?: string | null
  /**
   * The SOURCE's observed audio codec (`BrokerStats.audio.codec`), or `null`
   * when it is not known at spawn time. Only ever used to decide whether the
   * source audio can be COPIED; unknown resolves to the AAC re-encode, which
   * always produces an audible derived stream.
   */
  readonly sourceAudioCodec?: string | null
}

/** The argv, plus the audio decision behind it (for the caller's log line). */
export interface DerivedTranscodeArgs {
  readonly args: string[]
  readonly audio: DerivedAudioPlan
  readonly cadence: DerivedCadence
  readonly bitrate: DerivedBitrate
}

/**
 * Build the ffmpeg argv that reads a source loopback RTSP url, transcodes it
 * per `profile`, and writes `-f mpegts pipe:1` (what the feeder's `MpegTsDemux`
 * consumes).
 *
 * Two things are specific to a derived stream and are expressed as first-class
 * builder inputs rather than post-hoc edits:
 *
 * - `forceReencode` — a derived stream ALWAYS applies its video profile; that
 *   is its entire reason to exist. Without it the builder's smart-copy would
 *   elide the encode whenever the source already spoke the target codec. A
 *   `copy` profile still copies (a legitimate derived remux).
 * - the audio plan from {@link resolveDerivedAudio} in place of the profile's
 *   own — the MPEG-TS carrier, not the operator, decides whether the source
 *   track can be copied.
 */
/** The bitrate the derived encode runs with, and how it was reached. */
export interface DerivedBitrate {
  /** The cap (`-maxrate`), kbps; `null` when no geometry names one. */
  readonly capKbps: number | null
  /** The ABR target (`-b:v`), kbps; `null` when there is no cap. */
  readonly targetKbps: number | null
  /** The lowest accepted for this geometry x fps; `null` when unknown. */
  readonly floorKbps: number | null
  /** The explicit bitrate the profile asked for when it was raised to the floor. */
  readonly raisedFromKbps: number | null
}

/** The source picture size, when the broker knows it. */
export interface DerivedSourceResolution {
  readonly width: number
  readonly height: number
}

/**
 * Output pixels per second. A profile naming only a height (Resize mode) or
 * only a width takes the other side from the source's aspect ratio, so the
 * bitrate and floor are the same as for the equivalent width x height.
 */
function pixelsPerSecond(
  video: VideoEncode,
  outputFps: number | null,
  source: DerivedSourceResolution | undefined,
): number | null {
  let { width, height } = video
  if (source !== undefined && source.width > 0 && source.height > 0) {
    if (width === undefined && height !== undefined) {
      width = Math.round((height * source.width) / source.height / 2) * 2
    } else if (height === undefined && width !== undefined) {
      height = Math.round((width * source.height) / source.width / 2) * 2
    }
  }
  if (width === undefined || height === undefined) return null
  return width * height * (outputFps ?? DERIVED_DEFAULT_GOP_FRAMES)
}

/**
 * The bitrate WE manage for a geometry: derived from output pixels x fps when
 * the profile names none, raised to the floor when it names one below it.
 * Without a geometry there is nothing to scale by, so the profile's own value
 * (if any) is kept and no floor applies.
 */
export function resolveDerivedBitrate(
  video: VideoEncode,
  outputFps: number | null,
  sourceResolution?: DerivedSourceResolution,
): DerivedBitrate {
  const pps = pixelsPerSecond(video, outputFps, sourceResolution)
  const scaled =
    pps === null
      ? null
      : Math.round(
          (DERIVED_BITRATE_REFERENCE_KBPS * pps) / DERIVED_BITRATE_REFERENCE_PIXELS_PER_SECOND,
        )
  const floorKbps =
    scaled === null
      ? null
      : Math.max(
          DERIVED_BITRATE_FLOOR_MIN_KBPS,
          Math.round(scaled * DERIVED_BITRATE_FLOOR_FRACTION),
        )
  const requested = video.bitrateKbps ?? null
  const raised = requested !== null && floorKbps !== null && requested < floorKbps
  const capKbps = raised ? floorKbps : (requested ?? scaled)
  return {
    capKbps,
    targetKbps:
      capKbps === null ? null : Math.max(1, Math.round(capKbps * DERIVED_ABR_TARGET_FRACTION)),
    floorKbps,
    raisedFromKbps: raised ? requested : null,
  }
}

/**
 * Fill the encode knobs the CARRIER owns, leaving every one the profile names
 * untouched. Same rule as the audio decision above: an operator states intent,
 * the carrier states what its own hops can survive.
 *
 * - **GOP.** x264's own default is keyint=250 — TEN seconds at the fleet's
 *   25 fps. Measured live (camera dispensa, 2026-08-19): 1 I-frame in 250 on a
 *   recorded low segment, and a WebRTC viewer joining mid-GOP decoded
 *   reference-less P-frames for up to 10 s — the smear artifacts on every live
 *   open of a derived tier, grid tiles included.
 *
 * - **B-frames, preset, tune.** Measured live (camera 1438, 2026-08-20) by
 *   reading the camera's burnt-in OSD out of RECORDED segments and comparing
 *   it against the wall clock the recorder named the file with. Same camera,
 *   so the same OSD clock; mid-roll samples only, because the first segment of
 *   a triggered roll carries pre-roll and is older than its own name:
 *
 *     native `high` (-c:v copy):  -1s  -1s  -1s  -2s
 *     derived `low` (transcode):  -3s  -3s  -3s  -3s
 *
 *   ~2 s, and it is the encoder holding frames back: `preset medium` carries
 *   `rc-lookahead=40` (1.6 s at 25 fps) on top of `bframes=3` with b-adapt and
 *   b-pyramid. The recorder stamps a segment with the wall clock at WRITE
 *   time, so all of it becomes a MISLABEL: seeking a derived tier to an
 *   event's timestamp lands ~2 s past the event while the native tier of the
 *   same camera lands on it.
 *
 * - **Bitrate.** A CEILING (`-maxrate`) plus an ABR target at
 *   {@link DERIVED_ABR_TARGET_FRACTION} of it (`-b:v`, see `buildRateControlArgs`
 *   with `targetFraction`), derived from output pixels x fps and never below the
 *   per-geometry floor ({@link resolveDerivedBitrate}), because a derived tier is RECORDED
 *   and the scrub reads a `low` segment whole only while it is under its
 *   ceiling (D163: 4 MB hard cap today, 1.5 MB when this was measured). Uncapped CRF has no relationship to that ceiling: 1438/low
 *   measured 537–941 kbps at 640x360@25 against 142 kbps for camera 101's
 *   NATIVE low at the identical geometry, peaking at 1.19 MB in a 10 s
 *   segment. Quiet scenes still spend less than the cap.
 */
function withCarrierDefaults(
  video: VideoEncode,
  cadence: DerivedCadence,
  bitrate: DerivedBitrate,
): VideoEncode {
  const { fps, ...rest } = video
  const bitrateKbps = bitrate.capKbps ?? undefined
  return {
    ...rest,
    // A clamped request drops the fps: the source cadence passes through.
    ...(fps !== undefined && !cadence.fpsClamped ? { fps } : {}),
    gopFrames: cadence.gopFrames,
    bf: video.bf ?? DERIVED_DEFAULT_BF,
    preset: video.preset ?? DERIVED_DEFAULT_PRESET,
    tune: video.tune ?? DERIVED_DEFAULT_TUNE,
    ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
  }
}

export function buildDerivedTranscodeArgs(input: DerivedTranscodeArgsInput): DerivedTranscodeArgs {
  const audio = resolveDerivedAudio(input.profile.audio, input.sourceAudioCodec)
  const cadence = resolveDerivedCadence(input.profile.video, input.sourceCadence)
  const bitrate = resolveDerivedBitrate(
    input.profile.video,
    cadence.outputFps,
    input.sourceResolution,
  )
  const video = withCarrierDefaults(input.profile.video, cadence, bitrate)
  const args = buildFfmpegArgs(
    invocationFromEncodeProfile({
      profile: { ...input.profile, video, audio: audio.audio },
      // A derived stream forces a re-encode, so the source codec never
      // short-circuits the encode block; `h264` is inert here.
      sourceCodec: 'h264',
      forceReencode: true,
      sourceUrl: input.loopbackUrl,
      sink: { kind: 'stdout', container: 'mpegts' },
      decodeHwAccel: input.decodeHwAccel ?? null,
      fpsMode: cadence.fpsMode,
      rateControl: {
        kind: 'cap',
        vbvSeconds: cadence.vbvSeconds,
        targetFraction: DERIVED_ABR_TARGET_FRACTION,
      },
    }),
  )
  return { args, audio, cadence, bitrate }
}

/** What the derived feeder's ffmpeg is actually told to do — the schema's type, so the wire and this cannot drift. */
export type DerivedEffectiveEncode = DerivedEffectiveEncodeStats

function argValue(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag)
  return i === -1 ? null : (args[i + 1] ?? null)
}

function kbpsOf(value: string | null): number | null {
  if (value === null) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

/** Read the effective encode off the argv the builder produced (the argv IS what runs). */
export function describeEffectiveEncode(built: DerivedTranscodeArgs): DerivedEffectiveEncode {
  const { args, cadence, audio } = built
  return {
    encoder: argValue(args, '-c:v'),
    fps: cadence.outputFps,
    gopFrames: cadence.gopFrames,
    targetKbps: kbpsOf(argValue(args, '-b:v')),
    capKbps: kbpsOf(argValue(args, '-maxrate')),
    bufsizeKbps: kbpsOf(argValue(args, '-bufsize')),
    audio:
      audio.decision.kind === 'copy'
        ? 'copy'
        : audio.decision.kind === 'recode-aac'
          ? 'aac'
          : 'profile',
  }
}
