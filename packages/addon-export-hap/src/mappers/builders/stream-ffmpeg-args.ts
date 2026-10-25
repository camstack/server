/**
 * The ffmpeg PLAN for one HomeKit streaming session.
 *
 * This file used to assemble the argument vector by hand. It no longer emits a
 * single argument: it describes the session as an {@link FfmpegInvocation} and
 * `buildFfmpegArgs` (`@camstack/types` `ffmpeg/invocation.ts`) emits every one.
 * The repo keeps exactly ONE argv builder — `scripts/check-ffmpeg-primitive.ts`
 * Rule 1 refuses a second, and HomeKit was the last exception (D67).
 *
 * ## What moved behind the primitive, and what stayed here
 *
 * MOVED — everything that describes an ENCODE, because it is the same job every
 * other live egress does and the repo had five disagreeing copies of it: the
 * encoder, preset, tune, profile, level, pixel format, rate, GOP, the tight VBV
 * window ({@link RATE_CONTROL_TIGHT}), the bitstream filter, and the Opus block
 * ({@link HAP_AUDIO_BASE}).
 *
 * STAYED — everything that is a HAP PROTOCOL fact and belongs to no other
 * consumer: the payload types, the SSRCs (and their signed-int32 coercion), the
 * MTU baked into each `rtp://…?pkt_size=` target, the loopback ports the
 * JS-side SRTP encrypt reads from, and the negotiated audio sample rate and
 * packet time.
 *
 * ## The two flags this file exists to protect
 *
 * `-g` and `-bsf:v dump_extra` were two of the four causes of the year-long
 * failure, and both live in the encode plan now. They are asserted by token
 * AND by position in `__tests__/stream-ffmpeg-argv.spec.ts`, on both the copy
 * and the encode branch, so the move behind the primitive cannot quietly drop
 * either. Every other comment below records something learned the expensive
 * way; deleting one loses the reason a flag is there.
 */
import {
  type FfmpegAudioPlan,
  type FfmpegInvocation,
  type FfmpegVideoPlan,
  HAP_AUDIO_BASE,
  HAP_AUDIO_BITRATE_KBPS,
  HAP_AUDIO_VBV_KBITS,
} from '@camstack/types'
import type { HwDecodeDecision } from './stream-hwaccel.js'

/**
 * Opus encoder targets — kept low because:
 *  - Camera audio is overwhelmingly speech / ambient noise; 24 kbps mono
 *    is the published "fullband speech" sweet spot for libopus (well
 *    above the 20 kbps "wideband speech" floor).
 *  - HAP audio is one-shot live (no buffering on the controller side),
 *    so under-shooting the bitrate is cheaper than over-shooting it and
 *    hitting jitter.
 *  - Mono / low-delay profile matches Apple Home's published Opus decoder
 *    expectations for camera accessories.
 *
 * The numbers themselves live in `@camstack/types` `ffmpeg/encode-defaults.ts`
 * now, alongside every other live-egress constant, so the five sets that used
 * to disagree about Opus channel count can be diffed in one place. Re-exported
 * here because the session telemetry reports the bitrate it dialled.
 */
export const OPUS_BITRATE_KBPS = HAP_AUDIO_BITRATE_KBPS

export interface SessionInvocationInput {
  /**
   * How this session decodes, from
   * {@link import('./stream-hwaccel.js').selectHwDecode}. The decision is
   * passed WHOLE rather than as pre-rendered flags: the shared builder is the
   * only thing allowed to emit `-hwaccel`, which is how the flag is kept
   * strictly before `-i`. ffmpeg accepts it in output position without any
   * error and then decodes in software anyway — the CPU cost stays, the GPU is
   * idle, and the log line still says hardware.
   */
  readonly decode: HwDecodeDecision
  readonly rtspUrl: string
  /** From `buildVideoPlan` — pass-through or the rate-capped re-encode. */
  readonly video: FfmpegVideoPlan
  readonly videoTarget: string
  readonly audioTarget: string
  readonly videoPayloadType: number
  /** ALREADY coerced to signed int32 by the caller — see the note below. */
  readonly videoSsrcSigned: number
  readonly audioPayloadType: number
  readonly audioSsrcSigned: number
  /** `request.audio.packet_time`, ms. */
  readonly audioPacketTimeMs: number
  /** `request.audio.sample_rate`, kHz as HAP reports it. */
  readonly audioSampleRateKhz: number
}

/**
 * The Opus plane, per session.
 *
 * Re-encoded regardless of source codec: the source pool is a mix of
 * PCM_MULAW, PCM_ALAW, G.711 and AAC depending on driver, and Apple Home
 * expects Opus on the wire.
 *
 * `sampleRateHz` and `frameDurationMs` are NEGOTIATED — the controller picks
 * them — which is why the shared {@link HAP_AUDIO_BASE} leaves both out and
 * they are filled in here.
 *
 * CRITICAL on the sample rate: encode at the rate iOS asked for, never a
 * constant. iOS's `AudioStreamingSamplerate` enum surfaces as 8 / 16 / 24 kHz;
 * encoding at 24 when iOS asked for 16 produces RTP timestamps stepping by 480
 * samples/packet against a clock expecting 320 — the SRTP frames decrypt
 * cleanly but the speaker stays mute, because the timestamps slide out of the
 * AV-sync window before the first Opus frame renders. The same request value
 * drives `audioIntervalScale` in the re-stamping pass, so the two MUST come
 * from one source.
 *
 * On the frame duration: libopus emits exactly one RTP packet per Opus frame at
 * that duration, and matching HAP's `packet_time` (20 ms on LAN, 30/40/60 on
 * LTE) is what keeps the 1:1 frame↔packet mapping the controller expects.
 */
function audioPlan(input: SessionInvocationInput): FfmpegAudioPlan {
  return {
    ...HAP_AUDIO_BASE,
    sampleRateHz: input.audioSampleRateKhz * 1000,
    frameDurationMs: input.audioPacketTimeMs,
    vbvBufferKbits: HAP_AUDIO_VBV_KBITS,
  }
}

/**
 * Two outputs from one input: video SRTP and audio SRTP, one process, one
 * lifetime, one kill signal. The shared builder's `rtp-outputs` sink maps each
 * plane explicitly (`-an -map 0:v:0` / `-vn -map 0:a:0?`) so ffmpeg never
 * guesses which stream belongs where, and `0:a:0?` makes the audio optional so
 * a source with no microphone skips it instead of failing the invocation.
 */
/**
 * How long ffmpeg may inspect the broker's restream before emitting.
 *
 * Not zero. A zero-length probe makes ffmpeg trust the SDP completely, and an
 * RTSP source that announces a track it then never sends would leave the
 * mapping wrong with no way to notice. 200 ms and 64 KB is far below the
 * shortest key-frame interval on this fleet while still letting the demuxer
 * see real packets — enough to be honest, short enough that nobody watches it.
 */
const HAP_INPUT_PROBE = { analyzeDurationUs: 200_000, probeSizeBytes: 64 * 1024 } as const

/**
 * ONE encoder thread on the encode branch, none pinned on a copy. (D515)
 *
 * The plan asks x264 for one slice per access unit (`sliced-threads=0`). On
 * its own that flag hands x264 its AUTO thread count — 30 on the 20-core hub —
 * as FRAME threads, and frame threading delays output by `threads − 1`
 * frames: measured on the live hub as the first packet leaving ~3 s later at
 * the 10 fps a 269 kbps budget dials. Four threads still cost ~1 s. One thread
 * was measured with no start-up delay, one slice, and — unlike the eleven-slice
 * encode — no `VBV underflow` from x264, and a 720p `ultrafast` encode is far
 * inside what one core carries. A session is bounded by what one controller
 * asked for, never by this host's core count.
 *
 * `-threads` is an OUTPUT option here, emitted inside the video leg by the
 * shared builder, so it never reaches the decoder or the audio leg.
 */
const HAP_ENCODER_THREADS = 1

function encoderThreadCount(video: FfmpegVideoPlan): number {
  return video.kind === 'encode' ? HAP_ENCODER_THREADS : 0
}

export function buildSessionInvocation(input: SessionInvocationInput): FfmpegInvocation {
  return {
    // `warning` keeps stderr quiet during steady state and only surfaces errors
    // and format-negotiation issues. This was at `info` while debugging the
    // SRTP / libopus tear-down loop — now that the path is stable (resampler +
    // RTCP SR + correct SSRC + per-iOS-resolution picker) the verbosity is
    // just log noise.
    logLevel: 'warning',
    decodeHwAccel: input.decode.hwaccel,
    input: {
      url: input.rtspUrl,
      rtspTransport: 'tcp',
      // The controller is watching a loader for every microsecond of this.
      //
      // ffmpeg's defaults inspect the input for up to 5 s / 5 MB before it
      // emits ANYTHING, and the budget is wall-clock over an input measured in
      // frames per second — so the SLOWER the slot, the longer the stall.
      // Measured on the live hub, 101/mid at 9 fps: 9 s from `stream started`
      // to the first packet out of ffmpeg, 12.2 s to the first key frame. The
      // same camera's 25 fps slot filled the probe quickly and looked fine,
      // which is exactly why this hid behind "it works on some cameras".
      //
      // There is nothing to discover here: the source is the broker's own RTSP
      // restream, whose SDP declares the codec, and the slot we are dialling
      // was chosen by name. `HAP_INPUT_PROBE` documents both numbers together.
      analyzeDurationUs: HAP_INPUT_PROBE.analyzeDurationUs,
      probeSizeBytes: HAP_INPUT_PROBE.probeSizeBytes,
      // NOTE: do NOT add `-fflags +genpts` here. It rewrites input PTS at the
      // demuxer for ALL streams, including the H.264 video we `-c:v copy`
      // through unchanged — the resulting RTP timestamps confuse iOS's decoder,
      // which then displays only I-frames (one every 6-7 s on the typical
      // Hikvision GOP) and shows the stream as frozen between keyframes. The
      // audio-only jitter fix lives in the audio chain
      // (`-af aresample=async=…`), which sits AFTER the demuxer and touches
      // only audio frames.
      ...(input.decode.extraInputArgs.length > 0 ? { extraArgs: input.decode.extraInputArgs } : {}),
    },
    video: input.video,
    audio: audioPlan(input),
    threadCount: encoderThreadCount(input.video),
    outputArgs: [],
    sink: {
      kind: 'rtp-outputs',
      video: {
        url: input.videoTarget,
        payloadType: input.videoPayloadType,
        // ffmpeg parses `-ssrc` as int32 SIGNED — any value > 2^31-1 is
        // rejected with "out of range" + immediate exit. iOS hands us a uint32,
        // half of which falls above 2^31; the caller coerces via `| 0`, which
        // mangles the JS number to a signed int32 with the SAME bit pattern.
        // ffmpeg then writes those bits into the RTP header unchanged — iOS
        // sees the original SSRC.
        ssrc: input.videoSsrcSigned,
      },
      audio: {
        url: input.audioTarget,
        payloadType: input.audioPayloadType,
        ssrc: input.audioSsrcSigned,
      },
    },
  }
}
