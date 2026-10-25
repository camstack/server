/**
 * The argv of the permanent prebuffer child: what it reads, and whether it
 * re-encodes.
 *
 * ## The two branches, and why one of them is opt-in
 *
 * Measured on 101 (D84, 45 s samples, this exact argv): `-c:v copy` at 720p is
 * **0.7 % of one core and 30 MB**; a 4K→1080p `libx264 veryfast` is **89.9 %
 * and 577 MB**. The prebuffer runs whether or not anything is watching, so
 * those figures are permanent, per camera.
 *
 * That is why the encode branch exists only where an operator asked for it.
 * On this fleet 14 of 32 cameras publish H.265 on every slot and can never be
 * copied (measured 2026-09-21), so the alternative to this branch is not a
 * cheaper recording — it is no recording at all for those cameras. The switch
 * (`allowTranscode`) is the operator's, per camera, and {@link
 * pickRecordingSource} is the only thing that reads it.
 *
 * ## Decode is the expensive half
 *
 * The live transcode path measured 77 % of one core for 4K→1080p, **dominated
 * by decode**, and answers it with a hardware decoder read from the decoder
 * addon's own probe. The same backend is accepted here. The ENCODER stays
 * `libx264` for the reason `stream-hwaccel.ts` spells out: two of the four
 * causes of the year-long HomeKit failure were an absent `-g` and absent
 * in-band parameter sets, and both are load-bearing on the encoder —
 * `h264_vaapi` / `h264_qsv` carry their own rate control and emit parameter
 * sets on their own schedule.
 */
import type { FfmpegAudioPlan, FfmpegInvocation, FfmpegVideoPlan } from '@camstack/types'

import { HKSV_AUDIO_BITRATE_KBPS, HKSV_AUDIO_SAMPLE_RATE_HZ } from './recording-options.js'
import { MAX_RECORDING_HEIGHT, type RecordingSource } from './recording-source.js'

/** What the fragments will actually carry. */
export interface RecordingOutputResolution {
  readonly width: number
  readonly height: number
  /** The encoder is resizing; {@link RecordingSource} dimensions are the INPUT. */
  readonly scaled: boolean
}

/**
 * The resolution the accessory may advertise, which is the one it can deliver.
 *
 * A copy is advertised at its source size whatever that is — there is no
 * encoder to resize with, and advertising a size we cannot produce is the
 * "stream that does not match its own advertisement" defect in miniature.
 * A transcode above the ceiling is fitted down, because with an encoder in the
 * pipeline the 6.35 MB 4K fragment is a choice rather than a fact, and iOS
 * renders HKSV clips at 1080p regardless.
 */
export function recordingOutput(source: RecordingSource): RecordingOutputResolution {
  if (!source.transcode || source.height <= MAX_RECORDING_HEIGHT) {
    return { width: source.width, height: source.height, scaled: false }
  }
  const width = Math.max(
    2,
    Math.round((source.width * MAX_RECORDING_HEIGHT) / source.height / 2) * 2,
  )
  return { width, height: MAX_RECORDING_HEIGHT, scaled: true }
}

export interface RecordingInvocationInput {
  readonly source: RecordingSource
  /** Whether iOS currently wants audio in the fragments. */
  readonly audioActive: boolean
  /** The advertised fragment length — the IDR grid the encoder must hit. */
  readonly fragmentMs: number
  /**
   * The node's hardware DECODER, as `selectHwDecode` resolved it (`-hwaccel`'s
   * value), or `null` for software. Ignored on the copy branch, which decodes
   * nothing.
   */
  readonly decodeHwAccel: string | null
  /**
   * The input-side flags that travel WITH `-hwaccel` (`-hwaccel_device …`).
   *
   * Carried beside the backend rather than folded into it because they are
   * emitted in a different position, and a backend named without its render
   * node is a child that dies at init.
   */
  readonly decodeInputArgs?: readonly string[]
}

/** The invocation, minus the sink and sidecar the child owns. */
export function buildRecordingInvocation(
  input: RecordingInvocationInput,
): Omit<FfmpegInvocation, 'sink' | 'audioSidecar'> {
  const { source } = input
  const audio: FfmpegAudioPlan = input.audioActive
    ? {
        kind: 'encode',
        codec: 'aac',
        bitrateKbps: HKSV_AUDIO_BITRATE_KBPS,
        sampleRateHz: HKSV_AUDIO_SAMPLE_RATE_HZ,
        channels: 1,
      }
    : { kind: 'none' }

  const out = recordingOutput(source)
  const video: FfmpegVideoPlan = source.transcode
    ? {
        kind: 'encode',
        encoder: 'libx264',
        preset: 'veryfast',
        // Inside what `buildRecordingOptions` advertises.
        profile: 'main',
        level: '4.0',
        pixelFormat: 'yuv420p',
        // The fragment is cut at a key frame, so the IDR cadence IS the
        // fragment cadence. Left to the source, a camera with a 10 s GOP would
        // hand a 4 s promise 10 s fragments.
        forceKeyFramesSeconds: Math.max(1, Math.round(input.fragmentMs / 1000)),
        // HKSV fragments are handed over in decode order and replayed from a
        // ring; reordering buys compression nobody asked for.
        bf: 0,
        ...(out.scaled ? { scale: { mode: 'fit', width: out.width, height: out.height } } : {}),
      }
    : { kind: 'copy' }

  return {
    logLevel: 'error',
    // A copy branch that asked for `-hwaccel` would pay a device init for a
    // pipeline that never touches a frame, and on this hub that init is the
    // failure that killed the push transport (`code=244`).
    decodeHwAccel: source.transcode ? input.decodeHwAccel : null,
    input: {
      url: input.audioActive ? source.url : source.mutedUrl,
      rtspTransport: 'tcp',
      ...(source.transcode &&
      input.decodeInputArgs !== undefined &&
      input.decodeInputArgs.length > 0
        ? { extraArgs: input.decodeInputArgs }
        : {}),
      // The SDP already declares the codec, so there is nothing to discover;
      // ffmpeg's 5 s / 5 MB defaults would delay the first fragment by that
      // long on every respawn.
      analyzeDurationUs: 1_000_000,
      probeSizeBytes: 1_000_000,
    },
    video,
    audio,
    threadCount: 0,
    outputArgs: [],
  }
}
