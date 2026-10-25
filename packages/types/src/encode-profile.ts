import { z } from 'zod'

/**
 * Shared video / audio encode profile schemas used by every consumer
 * that asks the stream broker to spawn a derived stream
 * (WebRTC, HAP, Alexa, custom addons).
 *
 * The schema is intentionally simple: typed common fields + two
 * free-text arrays (inputArgs / outputArgs). The composite UI widget
 * `stream-broker/ffmpeg-params` is the smart layer — it routes
 * codec-specific overrides into the right scope and handles
 * dependency gating, duplicate detection, and source-aware
 * suggestions before persistence.
 */

export const VideoEncodeSchema = z.object({
  codec: z.enum(['h264', 'h265', 'copy']),
  profile: z.enum(['baseline', 'main', 'high']).optional(),
  /**
   * `-level`, e.g. `'3.1'`. A consumer that ADVERTISES a level in its SDP
   * (`profile-level-id=42e01f` is Baseline 3.1) must constrain the encoder to
   * it, or it ships a stream that does not match its own advertisement — the
   * defect class that kept HomeKit black for a year and that Alexa carried
   * silently. Optional because a browser negotiates the level itself.
   */
  level: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  bitrateKbps: z.number().int().positive().optional(),
  gopFrames: z.number().int().positive().optional(),
  bf: z.number().int().min(0).optional(),
  preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']).optional(),
  tune: z.enum(['zerolatency', 'film', 'animation']).optional(),
  /**
   * ONE slice per access unit.
   *
   * `-tune zerolatency` turns on x264's sliced threads, and a frame then leaves
   * the encoder as five NAL slices that share one RTP timestamp and carry one
   * marker bit. A libwebrtc depacketiser sees five frame-starts and one
   * frame-end per frame: the first pictures render and the video then freezes
   * for good while the audio, on its own plane, plays on. Measured on this hub
   * 2026-09-13 against the Echo, and reduced to one slice by this flag alone.
   *
   * A NAMED field and not a raw flag, because {@link EgressEncodeSchema} omits
   * `outputArgs` on purpose: an opaque array is part of the sharing key, so two
   * consumers meaning the same thing spelled differently would stop sharing one
   * child. Absent means "whatever the encoder does" — today's behaviour.
   */
  singleSlicePerFrame: z.boolean().optional(),
})
export type VideoEncode = z.infer<typeof VideoEncodeSchema>

export const AudioEncodeSchema = z.union([
  z.literal('passthrough'),
  z.object({
    codec: z.enum(['opus', 'aac', 'pcmu', 'pcma', 'copy']),
    bitrateKbps: z.number().int().positive().optional(),
    sampleRateHz: z.number().int().positive().optional(),
    channels: z.union([z.literal(1), z.literal(2)]).optional(),
  }),
])
export type AudioEncode = z.infer<typeof AudioEncodeSchema>

export const EncodeProfileSchema = z.object({
  video: VideoEncodeSchema,
  audio: AudioEncodeSchema,
  /**
   * ffmpeg input-side args, inserted between the fixed global flags
   * (`-hide_banner -loglevel error`) and `-i pipe:0`. Free-text array
   * — the widget surfaces a textarea + suggestion chips for the most-
   * used demuxer/format options.
   */
  inputArgs: z.array(z.string()).optional(),
  /**
   * ffmpeg output-side args, inserted between the encode block and
   * the final `-f <muxer> pipe:1`. Use for muxer options, bitstream
   * filters, codec-specific overrides. Free-text array.
   */
  outputArgs: z.array(z.string()).optional(),
})
export type EncodeProfile = z.infer<typeof EncodeProfileSchema>

/**
 * Reshape a publisher-advertised stream shape (a `CameraStream`, a broker
 * `ProfileSlot`, or anything else exposing `codec` + `resolution` + `fps`)
 * into an `EncodeProfile` suitable for the read-only "Source (probed)"
 * card of the `stream-broker/ffmpeg-params` widget.
 *
 * Returns `undefined` when nothing meaningful was advertised — the widget
 * then hides the card rather than showing a codec chip with no shape.
 * Audio is reported as `'passthrough'` because publishers don't carry
 * audio shape at this level; the widget renders that as a single chip.
 */
export function encodeProfileFromStreamShape(stream: {
  readonly codec?: string
  readonly resolution?: { readonly width: number; readonly height: number }
  readonly fps?: number
}): EncodeProfile | undefined {
  // Canonicalize codec strings — publishers report `H.264` / `h264` /
  // `H.265` / `HEVC` interchangeably; the widget needs a single tag.
  const codecNorm = stream.codec?.toLowerCase().replace(/[.\s-]/g, '')
  const codec: VideoEncode['codec'] = codecNorm === 'h265' || codecNorm === 'hevc' ? 'h265' : 'h264'
  const video: VideoEncode = {
    codec,
    ...(stream.resolution?.width !== undefined ? { width: stream.resolution.width } : {}),
    ...(stream.resolution?.height !== undefined ? { height: stream.resolution.height } : {}),
    ...(stream.fps !== undefined ? { fps: stream.fps } : {}),
  }
  if (video.width === undefined && video.height === undefined && video.fps === undefined) {
    return undefined
  }
  return { video, audio: 'passthrough' as const }
}
