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
 * 625 kbps at 640x360@25 — and a 10 s segment of 625 kbps is ~780 KB, half of
 * the scrub's 1.5 MB whole-segment ceiling (D163).
 */
const DERIVED_BITRATE_REFERENCE_KBPS = 2500
const DERIVED_BITRATE_REFERENCE_PIXELS_PER_SECOND = 1280 * 720 * 25

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

export interface DerivedTranscodeArgsInput {
  readonly profile: EncodeProfile
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
/**
 * The rate ceiling for a geometry, or `undefined` when the profile named no
 * geometry to scale by (there is then nothing to derive a number from, and a
 * guessed cap on an unknown resolution is worse than none).
 */
function derivedBitrateCeilingKbps(video: VideoEncode): number | undefined {
  const { width, height } = video
  if (width === undefined || height === undefined) return undefined
  const pixelsPerSecond = width * height * (video.fps ?? DERIVED_DEFAULT_GOP_FRAMES)
  return Math.round(
    (DERIVED_BITRATE_REFERENCE_KBPS * pixelsPerSecond) /
      DERIVED_BITRATE_REFERENCE_PIXELS_PER_SECOND,
  )
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
 * - **Bitrate.** A CEILING (`-maxrate`, no `-b:v` — see `buildRateControlArgs`,
 *   whose default rate control is `cap`), because a derived tier is RECORDED
 *   and the scrub reads a `low` segment whole only while it is under 1.5 MB
 *   (D163). Uncapped CRF has no relationship to that ceiling: 1438/low
 *   measured 537–941 kbps at 640x360@25 against 142 kbps for camera 101's
 *   NATIVE low at the identical geometry, peaking at 1.19 MB in a 10 s
 *   segment. Quiet scenes still spend less than the cap.
 */
function withCarrierDefaults(video: VideoEncode): VideoEncode {
  const bitrateKbps = video.bitrateKbps ?? derivedBitrateCeilingKbps(video)
  return {
    ...video,
    gopFrames: video.gopFrames ?? video.fps ?? DERIVED_DEFAULT_GOP_FRAMES,
    bf: video.bf ?? DERIVED_DEFAULT_BF,
    preset: video.preset ?? DERIVED_DEFAULT_PRESET,
    tune: video.tune ?? DERIVED_DEFAULT_TUNE,
    ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
  }
}

export function buildDerivedTranscodeArgs(input: DerivedTranscodeArgsInput): DerivedTranscodeArgs {
  const audio = resolveDerivedAudio(input.profile.audio, input.sourceAudioCodec)
  const video = withCarrierDefaults(input.profile.video)
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
    }),
  )
  return { args, audio }
}
