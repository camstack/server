/** Shared Zod schemas used across streaming capabilities. */

import { z } from 'zod'
import type { FrameHandle } from '../../interfaces/frame-handle.js'
import type { AudioChunkFormat } from '../../audio/audio-chunk-format.js'
import { AUDIO_CHUNK_FORMATS } from '../../audio/audio-chunk-format.js'

// ── Broker profile slots ─────────────────────────────────────────────
//
// Camstack supports at most 3 system-wide quality profiles per device:
// `high`, `mid`, `low`. Valid combinations: {high,mid,low}, {high,low},
// {mid}. Every consumer (WebRTC, recording, pipeline, detection, frame
// transport) addresses a device's stream via `${deviceId}/${profile}`;
// the camera's physical cam-stream ids never leak past the broker.

export const CamProfileSchema = z.enum(['high', 'mid', 'low'])
export type CamProfile = z.infer<typeof CamProfileSchema>

/** Canonical ordering. Hard-coded; never sorted. */
export const CAM_PROFILE_ORDER = ['high', 'mid', 'low'] as const

/**
 * Which rung a per-camera consumer listens on: an explicit profile, or `auto`.
 *
 * `auto` is a REAL value, not an absent one — it means "resolve it by the rule
 * that consumer owns". It lives beside `CamProfile` because a rung is the only
 * operator-facing way to name a stream: a cam-stream id is broker-internal and
 * moves when a slot is reassigned, so a stored id silently stops meaning what
 * the operator picked. Today's one user is the audio analyser, whose rule is
 * "the lowest AVAILABLE native rung" (D537).
 */
export const AudioStreamPickSchema = z.union([CamProfileSchema, z.literal('auto')])
export type AudioStreamPick = z.infer<typeof AudioStreamPickSchema>

// ── Published cam stream (broker-owned registry) ─────────────────────
//
// A camera's physical stream, published to the broker via
// `streamBroker.publishCameraStream(...)`. The provider owns the
// lifecycle (re-publishes on boot, retracts on removal). The broker
// owns the registry: each entry is the pool of options an operator or
// addon can assign to a profile slot.
//
// Two kinds:
//   - `pull-*`: the broker dials the URL (RTSP / RTMP / HTTP).
//   - `push-annexb`: the provider emits Annex-B packets. The broker
//     signals demand via `stream-broker.onCamStreamDemand` events so
//     push-capable cams (e.g. Reolink Baichuan) only wake when a
//     profile is actively consuming them.

export const CamStreamKindSchema = z.enum([
  'pull-rtsp',
  'pull-rtmp',
  'pull-http',
  /** HTTP-FLV pull (e.g. Reolink Baichuan media port, app `bcs`). The broker
   *  ALWAYS ingests this through its ffmpeg source reader — native TS clients
   *  cannot read FLV. */
  'pull-flv',
  'pull-rfc4571',
  'push-annexb',
  /** Broker-spawned ffmpeg transcode plane — reads from a source cam-stream
   *  and writes a re-encoded RTP plane. The broker routes demand signals to
   *  the source broker; the transcode process is single-flighted per
   *  identical EncodeProfile so multiple derived subscribers share one ffmpeg
   *  process. */
  'derived',
])
export type CamStreamKind = z.infer<typeof CamStreamKindSchema>

export const CamStreamResolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

export const CameraStreamSchema = z.object({
  /** Stable, provider-assigned id unique within the (deviceId) scope. */
  camStreamId: z.string().min(1),
  deviceId: z.number().int().nonnegative(),
  kind: CamStreamKindSchema,
  /** Required for pull-* kinds. Ignored for push-annexb. */
  url: z.string().optional(),
  codec: z.string().optional(),
  resolution: CamStreamResolutionSchema.optional(),
  fps: z.number().positive().optional(),
  /** Human label surfaced in the Admin UI "Camera Stream" dropdown. */
  label: z.string().optional(),
  /**
   * Device-level features the publisher advertised (e.g. `battery-operated`).
   * The broker, snapshot orchestrator, and prebuffer manager all consult
   * this list to derive policy — relaxed stall watchdog for battery
   * cams, prebuffer off by default, longer snapshot rate-limit, etc.
   *
   * Single source of truth replacing per-stream flags like the
   * historical `allowStall`: if the publisher knows the camera is
   * battery-powered, every downstream service derives the right policy
   * from this list.
   */
  deviceFeatures: z.array(z.string()).optional(),
  /**
   * Whether this stream participates in the broker's automatic profile
   * assignment (`computeInitialAssignment`). Defaults to `true`. Publishers
   * use `false` when they want a stream to be SELECTABLE in the UI but not
   * picked by default — e.g. Reolink publishes its native Baichuan streams
   * as `autoEligible: true` (the recommended path) and its RTSP / RTMP
   * mirrors as `autoEligible: false` (still pickable per slot, just not
   * the auto choice). Manual `assignProfile` calls remain valid for
   * non-eligible streams.
   */
  autoEligible: z.boolean().optional(),
  /**
   * The profile slot the PUBLISHER says this stream is: `low` for a stream
   * whose only sensible role is the low-bandwidth one, `high` for a main
   * stream. Consulted by the broker's automatic ranking
   * (`rankInitialAssignment`) BEFORE the pixel-count heuristic, and only there:
   * an operator's manual assignment still wins, and an absent hint is the
   * pixel-ranked default every camera had before this field existed.
   *
   * Why it exists: a camera with ONE stream ranked to `mid` — the slot no
   * storage class is written for on its own (`recordings` is high|mid,
   * `recordingsLow` is low) and the one profile scrub does not read. The robot
   * camera's single 720p relay is a `low` in every respect except the slot the
   * heuristic put it in.
   */
  profileHint: CamProfileSchema.optional(),
  /**
   * Transport-specific opaque metadata. The broker passes it through to
   * the source reader without inspecting it. Currently used by
   * `pull-rfc4571` streams to carry the upstream SDP (so the reader can
   * route RTP packets to the right depacketizer without an in-band
   * DESCRIBE phase). Other kinds typically leave it undefined.
   */
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type CameraStream = z.infer<typeof CameraStreamSchema>

// ── Profile slot view ────────────────────────────────────────────────
//
// Returned by the broker's `listAllProfileSlots` / the device-scoped
// `camera-streams.getBrokerStreams`. Describes one of the up-to-3
// system profile slots for a device: which cam stream is its source,
// runtime status, and public addressing info.

export const ProfileSlotStatusSchema = z.enum([
  'unassigned',
  'idle',
  'connecting',
  'streaming',
  'error',
])
export type ProfileSlotStatus = z.infer<typeof ProfileSlotStatusSchema>

export const ProfileSlotSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  profile: CamProfileSchema,
  /** Broker id the rest of the system addresses: `${deviceId}/${profile}`. */
  brokerId: z.string(),
  /** `null` when the profile is unassigned. */
  sourceCamStreamId: z.string().nullable(),
  status: ProfileSlotStatusSchema,
  resolution: CamStreamResolutionSchema.optional(),
  codec: z.string().optional(),
  preBufferSec: z.number().nonnegative().optional(),
  errorMessage: z.string().optional(),
})
export type ProfileSlot = z.infer<typeof ProfileSlotSchema>

// ── Canonical broker-id addressing ───────────────────────────────────
//
// Every consumer (WebRTC, recording, pipeline, detection …) addresses a
// device stream as `${deviceId}/${profile}`. Build/parse it ONLY through
// these helpers — never hand-concatenate the string and never address a
// physical cam-stream id (`native:main`, `derived:…`, `adaptive`), which
// stays broker-internal. Centralising the convention is what stops the
// recurring "wrong profile / wrong brokerId" class of bug.

/** The canonical consumer-facing broker id for a device profile. */
export function makeProfileBrokerId(deviceId: number, profile: CamProfile): string {
  return `${deviceId}/${profile}`
}

/**
 * The broker id keying a physical SOURCE stream: `${deviceId}/${camStreamId}`.
 * This is the broker's internal source key (`brokerIdFor` in the manager) — a
 * `camStreamId` like `native:main` — as opposed to the public profile alias
 * {@link makeProfileBrokerId}. Used to resolve a source's restream endpoint
 * (e.g. routing a transcode's ffmpeg input through the broker so it rides the
 * single source dial instead of opening a second camera connection).
 */
export function makeSourceBrokerId(deviceId: number, camStreamId: string): string {
  return `${deviceId}/${camStreamId}`
}

/**
 * Inverse of {@link makeProfileBrokerId}. Returns `null` when the string is
 * not a canonical `${deviceId}/${profile}` id — e.g. a broker-internal
 * cam-stream id (`5/native:main`), a derived/adaptive ref, or a malformed
 * value. So a caller can safely distinguish "addresses a public profile"
 * from "addresses something broker-internal".
 */
export function parseProfileBrokerId(
  brokerId: string,
): { deviceId: number; profile: CamProfile } | null {
  const slash = brokerId.indexOf('/')
  if (slash <= 0) return null
  const idPart = brokerId.slice(0, slash)
  const profilePart = brokerId.slice(slash + 1)
  if (!/^\d+$/.test(idPart)) return null
  const parsed = CamProfileSchema.safeParse(profilePart)
  if (!parsed.success) return null
  return { deviceId: Number(idPart), profile: parsed.data }
}

/**
 * The profile slots worth consuming/recording: ASSIGNED only
 * (`sourceCamStreamId != null`), DEDUPED by physical source so the same
 * camera encoder is never subscribed/recorded twice, ordered high→mid→low.
 * Optionally scoped to one `deviceId`. Pure; never mutates the input.
 *
 * Recording `main` and `mid` when both point at the same `sourceCamStreamId`
 * would dial the camera's internal stream twice for no benefit — this is the
 * dedup that prevents that.
 */
export function selectAssignedProfileSlots(
  slots: readonly ProfileSlot[],
  deviceId?: number,
): ProfileSlot[] {
  const ordered = [...slots]
    .filter((s) => deviceId === undefined || s.deviceId === deviceId)
    .toSorted((a, b) => CAM_PROFILE_ORDER.indexOf(a.profile) - CAM_PROFILE_ORDER.indexOf(b.profile))
  const seenSources = new Set<string>()
  const out: ProfileSlot[] = []
  for (const s of ordered) {
    const src = s.sourceCamStreamId
    if (src === null) continue
    if (seenSources.has(src)) continue
    seenSources.add(src)
    out.push(s)
  }
  return out
}

/**
 * Zod schema for StreamSourceEntry — the canonical stream descriptor
 * exposed by ICameraDevice.getStreamSources() and consumed by the broker.
 */
export const StreamSourceEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  protocol: z.enum(['rtsp', 'rtmp', 'annexb', 'http-mjpeg', 'webrtc', 'custom']),
  url: z.string().optional(),
  resolution: z.object({ width: z.number(), height: z.number() }).readonly().optional(),
  fps: z.number().optional(),
  bitrate: z.number().optional(),
  codec: z.string().optional(),
  profileHint: CamProfileSchema.optional(),
})

export const StreamSourceSchema = z.object({
  type: z.string(),
  url: z.string(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).readonly().optional(),
})

/**
 * Wire schema for `FrameHandle` — a zero-pixel, serialisable reference to a
 * frame in a shared-memory ring (Phase 5 / D9). Mirrors the `FrameHandle` TS
 * interface in `interfaces/frame-handle.ts` field-for-field so a cap method
 * (the runner's native-crop and pipeline-executor inputs) can carry handles
 * over tRPC / Moleculer.
 *
 * The `satisfies` assertion below pins this schema to the interface: if a
 * field is added to / removed from `FrameHandle` without a matching schema
 * edit, `z.infer<typeof FrameHandleSchema>` stops being assignable to
 * `FrameHandle` and the build fails — no silent drift.
 */
export const FrameHandleSchema = z.object({
  shmId: z.string(),
  slot: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.enum(['jpeg', 'rgb', 'bgr', 'yuv420', 'gray']),
  pts: z.number(),
  byteLength: z.number().int().nonnegative(),
  nodeId: z.string(),
  slotCount: z.number().int().positive(),
})

/**
 * Compile-time guard: `z.infer<typeof FrameHandleSchema>` must be assignable
 * to `FrameHandle` (and vice versa). The two `satisfies` checks fail to
 * compile on any field drift between the schema and the interface.
 */
type FrameHandleInferred = z.infer<typeof FrameHandleSchema>
const _frameHandleSchemaMatchesInterface = {} as FrameHandleInferred satisfies FrameHandle
const _frameHandleInterfaceMatchesSchema = {} as FrameHandle satisfies FrameHandleInferred
void _frameHandleSchemaMatchesInterface
void _frameHandleInterfaceMatchesSchema

/**
 * Wire schema for a decoded audio chunk (Phase 5 / D9). Mirrors the
 * `DecodedAudioChunk` TS interface in `interfaces/stream-broker.ts`: PCM
 * sample bytes plus the track parameters a consumer needs to interpret them.
 *
 * Audio chunks are tiny (a ~500ms AudioCodecSession window is a few KB of
 * Float32 PCM), so unlike video frames they ship their bytes INLINE over
 * tRPC / Moleculer — no shared-memory plane. `data` is typed `Uint8Array`
 * (the wire-serialisable supertype of `Buffer`); a `Buffer` is assignable to
 * it.
 */
export const AudioChunkFormatSchema = z.enum(AUDIO_CHUNK_FORMATS)

/**
 * Compile-time pin between this schema and the `AudioChunkFormat` TYPE in
 * `audio/audio-chunk-format.ts`.
 *
 * Both are derived from the same `AUDIO_CHUNK_FORMATS` const, so they cannot
 * drift today — but the type cannot be written as `z.infer<typeof …Schema>`
 * without a cycle (this file already imports the const FROM that module, and
 * that module is deliberately schema-free so the light entry points can use
 * it). The `satisfies` pair is the other half of the same rule: it fails to
 * compile the day someone widens one and not the other.
 */
const _audioChunkFormatSchemaMatchesType = {} as z.infer<
  typeof AudioChunkFormatSchema
> satisfies AudioChunkFormat
const _audioChunkFormatTypeMatchesSchema = {} as AudioChunkFormat satisfies z.infer<
  typeof AudioChunkFormatSchema
>
void _audioChunkFormatSchemaMatchesType
void _audioChunkFormatTypeMatchesSchema

export const DecodedAudioChunkSchema = z.object({
  data: z.instanceof(Uint8Array),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  timestamp: z.number(),
  /**
   * Byte format of `data`. ABSENT MEANS `f32le` — today's bytes, byte for
   * byte, for any peer that never heard of this field. A coded window
   * (`pcmu` / `pcma`, one byte per sample) is only ever emitted to a
   * subscription that DECLARED it accepts one, so absence can never mean
   * "coded bytes a consumer will read as floats" (D455).
   */
  format: AudioChunkFormatSchema.optional(),
})
export type DecodedAudioChunkWire = z.infer<typeof DecodedAudioChunkSchema>

/**
 * Input for `stream-broker.subscribeAudioChunks` (Phase 5 / D9). Audio ships
 * its bytes inline: a consumer asks the broker for the decoded audio-chunk
 * stream of one broker; the broker keeps a per-subscription bounded FIFO queue
 * the consumer drains via `pullAudioChunks`.
 */
export const SubscribeAudioChunksInputSchema = z.object({
  brokerId: z.string(),
  /** Short caller-identity tag (`audio-analyzer`, …) for `listClients`. */
  tag: z.string().optional(),
  /**
   * Byte formats this subscriber can READ, best first. The broker serves the
   * chunk's own format when it is in this list and expands to `f32le`
   * otherwise, so a subscriber is never handed bytes it cannot interpret.
   *
   * Absent (or without the source format) means `f32le` — the behaviour every
   * subscriber had before D455, unchanged. This is the negotiation half of
   * the source-bytes lever: it is what lets the broker and its consumers
   * deploy one at a time across three nodes.
   */
  accept: z.array(AudioChunkFormatSchema).readonly().optional(),
})
export type SubscribeAudioChunksInput = z.infer<typeof SubscribeAudioChunksInputSchema>

/** Result of `stream-broker.subscribeAudioChunks`. */
export const SubscribeAudioChunksResultSchema = z.object({
  /** Opaque id passed to `pullAudioChunks` / `unsubscribeAudioChunks`. */
  subscriptionId: z.string(),
})
export type SubscribeAudioChunksResult = z.infer<typeof SubscribeAudioChunksResultSchema>

export const BrokerStatusSchema = z.enum(['idle', 'connecting', 'streaming', 'error', 'stopped'])

export const BrokerStatsSchema = z.object({
  status: BrokerStatusSchema,
  inputFps: z.number(),
  encodedSubscribers: z.number(),
  uptimeMs: z.number(),
  bitrateKbps: z.number(),
  idrIntervalMs: z.number(),
  codec: z.string().optional(),
  totalBytes: z.number(),
  packetCount: z.number(),
  rtspClients: z.number(),
  pipeClients: z.number(),
  preBufferSec: z.number(),
  preBufferMs: z.number(),
  preBufferPackets: z.number(),
  /**
   * Detected audio track parameters from the RTSP DESCRIBE / SDP. `null`
   * when the stream has no audio track or the broker is in cold start.
   * `supported = false` means the codec was detected but the local
   * decoder pipeline cannot produce PCM chunks (e.g. AAC without the
   * AAC pipeline wired). Surfaced in the UI device-overview so operators
   * can pre-pick the audio-analysis model that matches the codec.
   */
  audio: z
    .object({
      codec: z.string(),
      sampleRate: z.number(),
      channels: z.number(),
      supported: z.boolean(),
    })
    .nullable()
    .optional(),
  /**
   * BROKER-SIDE AUDIO MUTE (D83). `true` = this broker is deliberately
   * distributing none of the device's audio, on live or recording.
   *
   * Present so a silent camera can be told apart from a broken one on the
   * stream panel itself, without cross-referencing the switch group: a
   * broker holding an `audio` track descriptor while `audioMuted` is true is
   * working exactly as asked. `audioMutedDropped` counts the audio units
   * thrown away since the current dial — it is how you confirm from stats
   * alone that the mute is on the packet path and not merely persisted.
   */
  audioMuted: z.boolean().optional(),
  audioMutedDropped: z.number().optional(),
})

/**
 * Exporter-facing "profile restream" entry. Returned by
 * `cameraStreams.getProfileRtspEntries` — one per ASSIGNED profile slot
 * (high/mid/low). `brokerId` is the PROFILE-keyed broker id
 * (`${deviceId}/${profile}`, e.g. `15/high`); its `url` is a broker
 * RTSP restream that aliases the profile's assigned source broker, so
 * every consumer dialling a profile converges on the same single pull.
 * `codec`/`resolution` describe the assigned SOURCE camStream (for the
 * `auto` resolution-closest pick). Distinct from `RtspRestreamEntry`
 * (raw per-camStream, live-view only).
 */
export const ProfileRtspEntrySchema = z.object({
  profile: CamProfileSchema,
  /** Profile-keyed broker id, format `${deviceId}/${profile}` (e.g. `"15/high"`). */
  brokerId: z.string(),
  url: z.string(),
  mutedUrl: z.string(),
  enabled: z.boolean(),
  codec: z.string().optional(),
  resolution: CamStreamResolutionSchema.optional(),
})
export type ProfileRtspEntry = z.infer<typeof ProfileRtspEntrySchema>
