import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Media-player cap. Models HA `media_player.*` (Sonos, Chromecast,
 * Apple TV, Spotify, Roku, generic OTT receivers, …) on
 * `DeviceType.MediaPlayer`. Disjoint from the camera streaming
 * surface — those use `DeviceType.Camera` + the broker pipeline.
 *
 * The cap declares a wide method surface; not every backend supports
 * every method. Drivers signal sub-capability via the
 * `DeviceFeature.MediaPlayerXxx` flags (paired one-to-one with the
 * corresponding method) so the UI gates buttons without a slice
 * fetch — same pattern as `PanTiltZoom` for cameras.
 */

export const MediaPlayerStateSchema = z.enum([
  'off',
  'on',
  'idle',
  'playing',
  'paused',
  'buffering',
  'standby',
])
export type MediaPlayerState = z.infer<typeof MediaPlayerStateSchema>

export const MediaPlayerRepeatSchema = z.enum(['off', 'all', 'one'])
export type MediaPlayerRepeat = z.infer<typeof MediaPlayerRepeatSchema>

const MediaInfoSchema = z.object({
  /** Free-form media kind (`music`, `tvshow`, `movie`, `app`, `channel`,
   *  `podcast`, …). */
  type: z.string(),
  /** Human-readable title. */
  title: z.string(),
  /** Optional artist / channel / station label. */
  artist: z.string().optional(),
  /** Optional album / season / show name. */
  album: z.string().optional(),
  /** Optional cover-art / thumbnail URL. */
  imageUrl: z.string().optional(),
})
export type MediaInfo = z.infer<typeof MediaInfoSchema>

export const MediaPlayerStatusSchema = z.object({
  /** Playback lifecycle state. */
  state: MediaPlayerStateSchema,
  /** Volume as 0..100 inclusive. Null when the device has no volume
   *  surface. Pair with `DeviceFeature.MediaPlayerVolume`. */
  volumeLevel: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Mute toggle distinct from volume=0. Null when no mute surface.
   *  Pair with `DeviceFeature.MediaPlayerMute`. */
  isMuted: z.boolean().nullable(),
  /** Active source / input. Empty when no source surface. */
  source: z.string(),
  /** Selectable sources. Empty when no source surface.
   *  Pair with `DeviceFeature.MediaPlayerSelectSource`. */
  availableSources: z.array(z.string()),
  /** Currently-playing media info. Null when nothing is playing. */
  currentMedia: MediaInfoSchema.nullable(),
  /** Current playback position in ms. Null when not seekable or
   *  nothing is playing. Pair with `DeviceFeature.MediaPlayerSeek`. */
  position: z.number().int().nonnegative().nullable().meta(readingMeta('duration-ms')),
  /** Total duration of the current media in ms. Null when unknown
   *  (live stream) or nothing is playing. */
  duration: z.number().int().nonnegative().nullable().meta(readingMeta('duration-ms')),
  /** Shuffle toggle. Null when no shuffle surface.
   *  Pair with `DeviceFeature.MediaPlayerShuffle`. */
  shuffle: z.boolean().nullable(),
  /** Repeat mode. Null when no repeat surface.
   *  Pair with `DeviceFeature.MediaPlayerRepeat`. */
  repeat: MediaPlayerRepeatSchema.nullable(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type MediaPlayerStatus = z.infer<typeof MediaPlayerStatusSchema>

export const mediaPlayerCapability = {
  name: 'media-player',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.MediaPlayer],
  methods: {
    play: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    pause: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    stop: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    next: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    previous: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    seek: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        position: z.number().int().nonnegative(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setVolume: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        volumeLevel: z.number().min(0).max(100),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setMute: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        muted: z.boolean(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setShuffle: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        shuffle: z.boolean(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setRepeat: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        repeat: MediaPlayerRepeatSchema,
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    selectSource: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        source: z.string().min(1),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    playMedia: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        /** Media identifier / URL. */
        mediaId: z.string().min(1),
        /** Media kind (`music`, `tvshow`, `movie`, `app`, …) — provider
         *  passes it through to the upstream service. */
        mediaType: z.string().min(1),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  status: {
    schema: MediaPlayerStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI players read the
   * full slice for live now-playing, volume, and progress updates
   * without polling.
   */
  runtimeState: MediaPlayerStatusSchema,

  /**
   * Runtime-state durability: **session** — a restored transport position describes a playback that stopped when the hub did.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): volume (a level an operator or an automation sets; the
   * default 10 s floor folds a slider drag into its end value) and mute.
   * `position` is not recorded: it moves continuously while playing.
   */
  history: {
    fields: {
      volumeLevel: { kind: 'gauge', unit: '%', deadband: 1 },
      isMuted: { kind: 'boolean' },
    },
  },
} as const satisfies CapabilityDefinition

export type IMediaPlayerProvider = InferProvider<typeof mediaPlayerCapability>
