import { z } from 'zod'
import {
  method,
  event,
  type CapabilityDefinition,
  type InferProvider,
} from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import {
  CameraStreamSchema,
  CamProfileSchema,
  CamStreamResolutionSchema,
  ProfileSlotSchema,
  ProfileSlotStatusSchema,
  ProfileRtspEntrySchema,
} from './schemas/streaming-shared.js'
import { RtspRestreamEntrySchema } from './stream-broker.cap.js'

// ── pickStream request / response ─────────────────────────────────────
//
// `pickStream` is the consumer-facing "given my decode constraints,
// what's the best published stream I can dial?" facade. It generalises
// the H.264-bypass logic originally inlined in `addon-export-alexa`'s
// `rtc-session.ts`: Echo only decodes H.264, so when a battery cam
// publishes both `native:main` HEVC + `native:sub` H.264, the picker
// returns the sub-stream and Alexa avoids a 3-6s `ffmpeg -c:v hevc →
// libx264` transcode. Every other broker consumer hits the same problem
// (HomeKit, browser fallbacks, WHEP), so this lives on the cap.

/** Codec aliases the matcher treats as equivalent (canonical lowercase). */
const STREAM_CODEC_VALUES = ['h264', 'h265', 'hevc', 'av1', 'mjpeg', 'vp8', 'vp9'] as const
export const StreamCodecSchema = z.enum(STREAM_CODEC_VALUES)
export type StreamCodec = z.infer<typeof StreamCodecSchema>

export const PickStreamRequirementsSchema = z
  .object({
    /**
     * Codecs the consumer can decode without an intermediate transcode.
     * Match is case-insensitive against the camera stream's `codec`.
     * Default (omitted / empty array): no codec filter — useful when the
     * consumer just wants "the highest-quality stream of any codec".
     */
    acceptCodecs: z.array(StreamCodecSchema).readonly().optional(),
    /** Minimum vertical resolution. Streams shorter than this are dropped. */
    minHeight: z.number().int().positive().optional(),
    /**
     * Maximum vertical resolution. Streams TALLER than this are dropped.
     *
     * A consumer can have a ceiling as real as its floor: Alexa documents
     * 480p to 1080p, and a 4K stream is as unusable to an Echo as a 360p one.
     * Without this the ceiling had to be re-implemented by every caller — and
     * one caller implementing it privately is how a second scoring authority
     * gets born.
     */
    maxHeight: z.number().int().positive().optional(),
    /** Minimum horizontal resolution. */
    minWidth: z.number().int().positive().optional(),
    /**
     * When true (default), `derived:*` streams (transcoded broker pipes)
     * are excluded — the caller wants a SOURCE stream the broker can
     * forward without a re-encode. Set false to allow derived in the
     * picker (useful for a "best playable" fallback).
     */
    excludeDerived: z.boolean().optional(),
    /**
     * Bypass gate. When set, the picker returns a hit ONLY IF the device
     * also exposes a non-derived stream in one of these (rejected) codecs.
     * Mirrors the Alexa "bypass only when the natural path WOULD have
     * transcoded" guard: if the device is already serving the consumer's
     * codec end-to-end, there's nothing to optimise.
     */
    requireSiblingCodec: z.array(StreamCodecSchema).readonly().optional(),
    /**
     * Whether a stream the consumer CANNOT decode may still be picked, on the
     * understanding that it will be transcoded.
     *
     * Default `false` — today's behaviour, and the right one for a bypass
     * question ("is there a stream I can forward untouched?"). Set `true` to
     * ask the larger question: "what is the best stream for me, transcoding if
     * I must?" A stream that satisfies `acceptCodecs` always outranks one that
     * does not, so a passthrough is never lost to a transcode; the answer says
     * which it is in {@link PickedCamStreamSchema.transcodes}.
     *
     * This is what lets one picker serve both the bypass and the full source
     * choice, instead of a consumer scoring privately when the bypass misses.
     */
    allowTranscode: z.boolean().optional(),
    /**
     * Consider ONLY streams the broker has bound to a profile slot.
     *
     * A consumer that dials the broker — which is every exporter, since none
     * of them may open the camera's own URL — can do nothing with a source
     * that has no slot: there is no restream to dial. Without this the picker
     * can name such a stream, and each consumer discovers the dead end for
     * itself: Alexa's `profileForCamStream` returns `null` and it quietly
     * falls back, and HomeKit would have had to grow the same function again.
     *
     * Default `false`, and deliberately so: the BROKER itself picks through
     * here when it decides which source to BIND to a slot
     * (`computeInitialAssignment`), and it must see the unbound ones or it
     * could never bind them.
     */
    requireProfileBound: z.boolean().optional(),
  })
  .readonly()

export const PickStreamPreferencesSchema = z
  .object({
    /**
     * Ordered list of provider prefixes (e.g. `['native:', 'rtsp:']`) the
     * picker prefers — earlier entries win ties. Defaults to
     * `['native:']`, mirroring Alexa's "prefer the native dial path".
     */
    preferredProviders: z.array(z.string()).readonly().optional(),
    /**
     * Resolution preference within the surviving candidates. `'highest'`
     * picks the tallest stream; `'lowest'` picks the shortest (used by
     * memory-constrained consumers / Apple Home guest sessions).
     */
    resolutionPreference: z.enum(['highest', 'lowest']).optional(),
    /**
     * The height the consumer actually wants to DELIVER.
     *
     * Not a constraint — an ordering. With it set, the SMALLEST stream at or
     * above the target wins, and only if nothing reaches it does the tallest
     * take over. Pulling 1296 lines to draw 720 on a 1280x800 Echo panel costs
     * a decode and buys nothing, and `resolutionPreference: 'highest'` cannot
     * express that: it says "as big as possible", which is a different wish.
     *
     * Ignored when absent, so every existing caller keeps its ordering.
     */
    targetHeight: z.number().int().positive().optional(),
  })
  .readonly()

export type PickStreamRequirements = z.infer<typeof PickStreamRequirementsSchema>
export type PickStreamPreferences = z.infer<typeof PickStreamPreferencesSchema>

export const PickedCamStreamSchema = z.object({
  camStreamId: z.string(),
  codec: z.string().optional(),
  resolution: CamStreamResolutionSchema.optional(),
  /**
   * Whether serving this stream requires a decode + re-encode.
   *
   * `false` is a stream the consumer can take as it stands. Only ever `true`
   * when the caller asked for it with `allowTranscode`, so a caller that did
   * not ask cannot be handed a cost it never agreed to pay.
   */
  transcodes: z.boolean(),
  /** One-line explanation of why this stream won — for logs / debug UI. */
  reason: z.string(),
  /**
   * The broker profile slot this source is bound to, when it is bound.
   *
   * Answered HERE because every consumer needs it and none of them can get it
   * from the `camStreamId` alone. Alexa wrote `profileForCamStream` for it —
   * a second cap read plus a `null` branch — and HomeKit was about to write
   * the same function a second time.
   *
   * Absent when the source has no slot, which a caller passing
   * `requireProfileBound` can never see.
   */
  profile: CamProfileSchema.optional(),
  /** The broker id of that slot, for logs that must name what was dialled. */
  brokerId: z.string().optional(),
  /**
   * The broker restream URL to dial for this stream.
   *
   * An exporter must never open the camera's own URL — the broker is the one
   * that dials the camera, and every consumer goes through its restream. So
   * the picker answers with the thing a consumer may actually use, instead of
   * naming a source and leaving each caller to look the URL up.
   */
  url: z.string().optional(),
  /**
   * Frames per second this stream really delivers, and where the number came
   * from.
   *
   * It is here because getting it wrong is expensive and silent: a HomeKit
   * accessory advertised 720p at 24 fps while the slot serving it ran at 9,
   * and the controller rendered nothing at all. The source is carried with the
   * value for the same reason the bitrate evidence is: `published` is what the
   * publisher declares and `measured` is what the broker observed, and they
   * are not interchangeable.
   */
  fps: z.number().positive().optional(),
  fpsSource: z.enum(['published', 'measured']).optional(),
})
export type PickedCamStream = z.infer<typeof PickedCamStreamSchema>

/**
 * Camera streams — device-scoped facade over the system `stream-broker`.
 *
 * Mirrors the slice of broker state relevant to a single device:
 *   - `getCameraStreams()`: the pool of physical streams published for
 *     this device. UI uses it to populate the "Camera Stream" dropdown
 *     under each quality section.
 *   - `getBrokerStreams()`: the (up to 3) profile slots `high/mid/low`
 *     with their current assignment + runtime status. UI uses it for
 *     the WebRTC quality picker, recording target selection, etc.
 *
 * Registered for every camera device that has at least one published
 * cam stream. The provider is owned by the stream-broker addon; reads
 * go against the broker's in-memory registries. Mutations (assign /
 * unassign / publish / retract) do NOT live here — they stay on the
 * system `stream-broker` cap so cross-device / addon-driven flows keep
 * a single namespace.
 */
export const cameraStreamsCapability = {
  name: 'camera-streams',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: [DeviceType.Camera],
  methods: {
    getCameraStreams: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      z.array(CameraStreamSchema).readonly(),
    ),
    getBrokerStreams: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      z.array(ProfileSlotSchema).readonly(),
    ),
    /**
     * Per-device RAW RTSP restream entries — one per published camStream
     * that has RTSP restream enabled (`native:main`, `rtsp:sub`, …).
     *
     * LIVE-VIEW ONLY. This is the surface the device-details stream
     * picker uses so an operator can hit each physical stream directly.
     * Programmatic / external consumers (HAP, Alexa, ha-mqtt, recording)
     * MUST use `getProfileRtspEntries` instead — picking from raw
     * variants makes two consumers of the same camera land on two
     * different physical pulls (e.g. Reolink `native:main` vs
     * `rtsp:main`) and trips the camera's concurrent-session limit.
     */
    getRtspEntries: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        /** Override hostname embedded in returned URLs. Defaults to the broker's bound address. */
        hostname: z.string().optional(),
      }),
      z.array(RtspRestreamEntrySchema).readonly(),
    ),
    /**
     * Per-device PROFILE RTSP restream entries — one per ASSIGNED
     * profile slot (high/mid/low). Each entry's `url` is a profile-keyed
     * broker restream that aliases the profile's assigned source broker,
     * so HAP / Alexa / recording / WebRTC all converge on the broker's
     * single on-demand pull for that profile. This is the supported
     * exporter-facing surface; the raw `getRtspEntries` is live-view
     * only. Returns `[]` for a device with no assigned profiles
     * (cold-start before first publish).
     */
    getProfileRtspEntries: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        /** Override hostname embedded in returned URLs. Defaults to the broker's bound address. */
        hostname: z.string().optional(),
      }),
      z.array(ProfileRtspEntrySchema).readonly(),
    ),
    /**
     * "Best source stream for these decode constraints". Returns the
     * camStreamId the caller should dial (or null when no stream
     * matches). See `PickStreamRequirementsSchema` for the filter shape
     * and `PickStreamPreferencesSchema` for the ranking inputs.
     *
     * Returning null instructs the caller to fall back to its existing
     * path (derived-broker transcode, profile-slot pick, etc.) — the
     * picker NEVER ranks `derived:*` candidates as a "match" because
     * its whole job is to avoid the transcode.
     */
    pickStream: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        requirements: PickStreamRequirementsSchema,
        preferences: PickStreamPreferencesSchema.optional(),
      }),
      PickedCamStreamSchema.nullable(),
    ),
  },
  events: {
    /** Fires on publishCameraStream / retractCameraStream. */
    onCamStreamsChanged: event(
      z.object({
        deviceId: z.number().int().nonnegative(),
        camStreams: z.array(CameraStreamSchema).readonly(),
      }),
    ),
    /** Fires on assignProfile / unassignProfile / runtime status change. */
    onProfileSlotsChanged: event(
      z.object({
        deviceId: z.number().int().nonnegative(),
        profileSlots: z.array(ProfileSlotSchema).readonly(),
      }),
    ),
  },
  /**
   * Per-device live stream-broker state. Persistent settings (RTSP
   * tokens, profile assignments, pre-buffer config, RTSP-enabled toggles,
   * streamingDebug) stay in the broker's addon store — they survive
   * restarts. The slice below carries ONLY what's truly runtime:
   *
   *   - `online` — at least one profile slot is currently `'streaming'`.
   *     Drivers without a firmware liveness signal (RTSP, ONVIF…) can
   *     subscribe and mirror this into `state.deviceStatus.online`.
   *   - `slotStatuses` — current `ProfileSlotStatus` per profile,
   *     mirroring the runtime-mutable subset of `ProfileSlot`.
   *   - `slotErrors` — last error message per profile (only set when the
   *     corresponding slot is in `'error'`).
   *   - `lastChangedAt` — freshness signal for consumers that want to
   *     reason about how stale the slice is.
   *
   * Written by the stream-broker manager on every transition that
   * affects these aggregates. Read via `device.state.cameraStreams.<field>`
   * (BaseDevice proxy) or, cross-process, via
   * `device-state.getCapSlice({deviceId, capName: 'camera-streams'})`.
   * The cap's `onChanged` event fires automatically on each write so
   * subscribers get push semantics for free.
   */
  runtimeState: z.object({
    online: z.boolean(),
    slotStatuses: z.object({
      high: ProfileSlotStatusSchema.optional(),
      mid: ProfileSlotStatusSchema.optional(),
      low: ProfileSlotStatusSchema.optional(),
    }),
    slotErrors: z.object({
      high: z.string().optional(),
      mid: z.string().optional(),
      low: z.string().optional(),
    }),
    lastChangedAt: z.number(),
  }),

  /**
   * Runtime-state durability: **session** — a restored `slotStatuses: streaming` for a camera that has been dark for two hours is a lie the UI renders as truth.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — `online` duplicates device-status.online (one authority); slot data is nested enum/string.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type ICameraStreamsProvider = InferProvider<typeof cameraStreamsCapability>
