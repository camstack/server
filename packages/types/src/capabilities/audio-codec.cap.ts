import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

// ── Schema fragments ─────────────────────────────────────────────────────────

const PcmSampleFormatSchema = z.enum(['f32le', 's16le'])

const AudioCodecInfoSchema = z.object({
  codec: z.string(),
  canDecode: z.boolean(),
  canEncode: z.boolean(),
  label: z.string().optional(),
})

const AudioDecodeSessionConfigSchema = z.object({
  codec: z.string(),
  sourceSampleRate: z.number().int().positive(),
  sourceChannels: z.number().int().positive(),
  extraData: z.instanceof(Uint8Array).optional(),
  targetSampleRate: z.number().int().positive(),
  targetChannels: z.number().int().positive(),
  targetFormat: PcmSampleFormatSchema.optional(),
  idleMs: z.number().int().positive().optional(),
  tag: z.string().optional(),
})

const AudioEncodeSessionConfigSchema = z.object({
  codec: z.string(),
  sourceSampleRate: z.number().int().positive(),
  sourceChannels: z.number().int().positive(),
  sourceFormat: PcmSampleFormatSchema.optional(),
  targetSampleRate: z.number().int().positive(),
  targetChannels: z.number().int().positive(),
  bitrateKbps: z.number().int().positive().optional(),
  idleMs: z.number().int().positive().optional(),
  tag: z.string().optional(),
})

const AudioPcmChunkSchema = z.object({
  data: z.instanceof(Uint8Array),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  format: PcmSampleFormatSchema,
  pts: z.number(),
})

const AudioEncodedChunkSchema = z.object({
  data: z.instanceof(Uint8Array),
  codec: z.string(),
  pts: z.number(),
  frameComplete: z.boolean(),
})

const SessionInventoryEntrySchema = z.object({
  sessionId: z.string(),
  kind: z.enum(['decode', 'encode']),
  codec: z.string(),
  sourceSampleRate: z.number(),
  sourceChannels: z.number(),
  targetSampleRate: z.number(),
  targetChannels: z.number(),
  format: PcmSampleFormatSchema,
  tag: z.string().optional(),
  createdAtMs: z.number(),
  lastActivityMs: z.number(),
  framesIn: z.number(),
  framesOut: z.number(),
})

// ── Capability definition ────────────────────────────────────────────────────

/**
 * audio-codec — bidirectional PCM ↔ encoded audio I/O box.
 *
 * Independent per-consumer sessions. The provider runs decode + resample
 * (or resample + encode) inside the session so a 16kHz mono ASA
 * subscriber and a 48kHz stereo WebRTC subscriber on the same source
 * stream don't share resamplers.
 *
 * Singleton on each node. Decoder and encoder live in the same provider
 * because they share the underlying libav contexts (node-av today,
 * pluggable later) — operators always install one or the other together.
 */
export const audioCodecCapability = {
  name: 'audio-codec',
  scope: 'system',
  mode: 'singleton',
  // With no operator override, `decoder-nodeav` wins the singleton active slot.
  // The audio codec is MERGED into the node-av decoder addon: one addon
  // (`decoder-nodeav`, seeded on every node) provides BOTH the `decoder` (video)
  // and `audio-codec` caps from a single process + one node-av load. node-av is
  // the primary media codec for audio AND video (mirrors `decoder.cap.ts`'s
  // `preferredProvider: 'decoder-nodeav'`): in-process libavcodec/libswresample,
  // no subprocess, raw AUs fed straight to CodecContext. It is the only
  // provider since the ffmpeg-subprocess `decoder-ffmpeg` addon was deleted
  // (D763).
  preferredProvider: 'decoder-nodeav',
  methods: {
    // ── Discovery ─────────────────────────────────────────────────────────
    /** Probe the local runtime and return the supported codec matrix. */
    listSupportedCodecs: method(z.void(), z.array(AudioCodecInfoSchema).readonly()),

    /** Cheap predicate — does the runtime support `(codec, kind)`? */
    canHandle: method(
      z.object({ codec: z.string(), kind: z.enum(['decode', 'encode']) }),
      z.boolean(),
    ),

    // ── Session lifecycle ─────────────────────────────────────────────────
    createDecodeSession: method(
      AudioDecodeSessionConfigSchema,
      z.object({ sessionId: z.string(), nodeId: z.string() }),
      { kind: 'mutation' },
    ),

    createEncodeSession: method(
      AudioEncodeSessionConfigSchema,
      z.object({ sessionId: z.string(), nodeId: z.string() }),
      { kind: 'mutation' },
    ),

    closeSession: method(
      z.object({ sessionId: z.string(), nodeId: z.string().optional() }),
      z.void(),
      { kind: 'mutation' },
    ),

    // ── Decode data plane ─────────────────────────────────────────────────
    // Session-bound methods include an optional `nodeId` field so the
    // generated cap router auto-routes calls to the same node that owns
    // the session. Audio-codec sessions are process-local — without sticky
    // routing the round-robin across nodes serves "session not found" on
    // every other call.

    /** Push one encoded audio frame into a decode session. */
    pushEncodedFrame: method(
      z.object({
        sessionId: z.string(),
        nodeId: z.string().optional(),
        data: z.instanceof(Uint8Array),
        /** Source PTS in milliseconds. Synthesised when omitted. */
        pts: z.number().optional(),
      }),
      z.void(),
      { kind: 'mutation' },
    ),

    /** Pull up to `maxCount` PCM chunks from a decode session. */
    pullPcm: method(
      z.object({
        sessionId: z.string(),
        nodeId: z.string().optional(),
        maxCount: z.number().int().positive().default(8),
      }),
      z.array(AudioPcmChunkSchema),
    ),

    // ── Encode data plane ─────────────────────────────────────────────────
    /** Push one PCM chunk into an encode session. */
    pushPcm: method(
      z.object({
        sessionId: z.string(),
        nodeId: z.string().optional(),
        data: z.instanceof(Uint8Array),
        /** Source PTS in milliseconds. */
        pts: z.number().optional(),
      }),
      z.void(),
      { kind: 'mutation' },
    ),

    /** Pull up to `maxCount` encoded chunks from an encode session. */
    pullEncoded: method(
      z.object({
        sessionId: z.string(),
        nodeId: z.string().optional(),
        maxCount: z.number().int().positive().default(8),
      }),
      z.array(AudioEncodedChunkSchema),
    ),

    /** Flush any pending encoded output (call before close on graceful tear). */
    flushEncode: method(
      z.object({ sessionId: z.string(), nodeId: z.string().optional() }),
      z.array(AudioEncodedChunkSchema),
      { kind: 'mutation' },
    ),

    // ── Inventory ─────────────────────────────────────────────────────────
    listActiveSessions: method(z.void(), z.array(SessionInventoryEntrySchema).readonly()),
  },
} as const satisfies CapabilityDefinition

export type IAudioCodecCapProvider = InferProvider<typeof audioCodecCapability>

export {
  AudioCodecInfoSchema,
  AudioDecodeSessionConfigSchema,
  AudioEncodeSessionConfigSchema,
  AudioPcmChunkSchema,
  AudioEncodedChunkSchema,
  PcmSampleFormatSchema,
}
