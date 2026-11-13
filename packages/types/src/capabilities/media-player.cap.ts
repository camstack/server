import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferProvider,
  optionalMethod,
} from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { REMOTE_SOURCE_KINDS } from '../remote/remote-sources.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

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

/**
 * Where `state`, `volumeLevel`, `isMuted` and `source` come from. `reported`:
 * the device said so. `assumed`: the driver has no feedback (infrared) and
 * tracks what it last SENT; it moves only after a send was accepted, and a
 * human at the real remote makes it wrong. A UI shows an assumed value as a
 * guess, never as a reading.
 */
export const MediaPlayerStateSourceSchema = z.enum(['reported', 'assumed'])
export type MediaPlayerStateSource = z.infer<typeof MediaPlayerStateSourceSchema>

/** The fields of a media-player status a driver can only guess. */
export const MediaPlayerAssumedFieldSchema = z.enum(['state', 'volumeLevel', 'isMuted', 'source'])
export type MediaPlayerAssumedField = z.infer<typeof MediaPlayerAssumedFieldSchema>

export const MediaPlayerStatusSchema = z.object({
  /** Playback lifecycle state. */
  state: MediaPlayerStateSchema,
  /**
   * Whether the state fields are readings or the driver's own bookkeeping.
   * A slice written before this field existed parses as `reported`.
   */
  stateSource: MediaPlayerStateSourceSchema.default('reported'),
  /**
   * Which fields are the driver's own guess. `stateSource` is `assumed` when
   * this is not empty; a field not listed here is a reading even then (power
   * from a running-state source, mute guessed from the last send).
   */
  assumedFields: z.array(MediaPlayerAssumedFieldSchema).default([]),
  /** Volume as 0..100 inclusive. Null when the device has no volume
   *  surface. Pair with `DeviceFeature.MediaPlayerVolume`. */
  volumeLevel: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Mute toggle distinct from volume=0. Null when no mute surface.
   *  Pair with `DeviceFeature.MediaPlayerMute`. */
  isMuted: z.boolean().nullable(),
  /**
   * True only when the provider READS the mute state back from the device.
   * Absent or false: mute is a momentary key. A non-null `isMuted` is not a
   * reading on its own — an infrared send can leave a value without this flag.
   */
  muteReadback: z.boolean().optional(),
  /** Active source / input. Empty when no source surface. */
  source: z.string(),
  /** Selectable sources. Empty when no source surface.
   *  Pair with `DeviceFeature.MediaPlayerSelectSource`. */
  availableSources: z.array(z.string()),
  /**
   * What each declared source IS, when the sources are the operator's own (a
   * remote, planning#460): an exporter offers a channel by number only for a
   * `digits` source and an input only for a `sequence` one. Absent when the
   * player's sources are its own.
   */
  declaredSources: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(REMOTE_SOURCE_KINDS),
        /** The channel number of a `digits` source. */
        number: z.string().optional(),
      }),
    )
    .optional(),
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
  /** Ms epoch when `position` was read from the device. Null when the driver
   *  does not say; a UI that advances the position while playing counts from it. */
  positionUpdatedAt: z.number().nullable().default(null),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type MediaPlayerStatus = z.infer<typeof MediaPlayerStatusSchema>

/** The most steps one volume / channel step call takes (the remote's repeat bound, D964). */
export const MEDIA_PLAYER_MAX_STEPS = 50

const stepInput = z.object({
  deviceId: z.number().int().nonnegative(),
  /** How many presses: the caller's count (Alexa `volumeSteps`, `channelCount`). */
  steps: z.number().int().min(1).max(MEDIA_PLAYER_MAX_STEPS).default(1),
})

const deviceOnly = z.object({ deviceId: z.number().int().nonnegative() })

export const mediaPlayerCapability = {
  name: 'media-player',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.MediaPlayer],
  power: {
    kind: 'methods',
    field: 'state',
    offValues: ['off', 'standby'],
    on: 'turnOn',
    off: 'turnOff',
  },
  methods: {
    turnOn: optionalMethod(deviceOnly, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.turnOn',
          label: t('Turn on', 'Accendi'),
          phrase: t('Turn on {device}', 'Accendi {device}'),
          icon: 'power',
        },
      ],
    }),
    turnOff: optionalMethod(deviceOnly, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.turnOff',
          label: t('Turn off', 'Spegni'),
          phrase: t('Turn off {device}', 'Spegni {device}'),
          icon: 'power',
        },
      ],
    }),
    volumeUp: optionalMethod(stepInput, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.volumeUp',
          label: t('Volume up', 'Alza il volume'),
          phrase: t('Raise the volume of {device}', 'Alza il volume di {device}'),
          icon: 'volume-2',
        },
      ],
    }),
    volumeDown: optionalMethod(stepInput, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.volumeDown',
          label: t('Volume down', 'Abbassa il volume'),
          phrase: t('Lower the volume of {device}', 'Abbassa il volume di {device}'),
          icon: 'volume-2',
        },
      ],
    }),
    channelUp: optionalMethod(stepInput, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.channelUp',
          label: t('Channel up', 'Canale successivo'),
          phrase: t('Go to the next channel on {device}', 'Passa al canale successivo su {device}'),
          icon: 'skip-forward',
        },
      ],
    }),
    channelDown: optionalMethod(stepInput, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.channelDown',
          label: t('Channel down', 'Canale precedente'),
          phrase: t(
            'Go to the previous channel on {device}',
            'Torna al canale precedente su {device}',
          ),
          icon: 'skip-back',
        },
      ],
    }),
    play: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.play',
          label: t('Play', 'Riproduci'),
          phrase: t('Play on {device}', 'Avvia la riproduzione su {device}'),
          icon: 'play',
        },
      ],
    }),
    pause: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.pause',
          label: t('Pause media', 'Metti in pausa'),
          phrase: t('Pause {device}', 'Metti in pausa {device}'),
          icon: 'pause',
        },
      ],
    }),
    stop: optionalMethod(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.stop',
          label: t('Stop media', 'Ferma la riproduzione'),
          phrase: t('Stop {device}', 'Ferma {device}'),
          icon: 'square',
        },
      ],
    }),
    next: optionalMethod(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.next',
          label: t('Next track', 'Brano successivo'),
          phrase: t('Skip to the next track on {device}', 'Passa al brano successivo su {device}'),
          icon: 'skip-forward',
        },
      ],
    }),
    previous: optionalMethod(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'media.previous',
          label: t('Previous track', 'Brano precedente'),
          phrase: t(
            'Go back to the previous track on {device}',
            'Torna al brano precedente su {device}',
          ),
          icon: 'skip-back',
        },
      ],
    }),
    setVolume: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        volumeLevel: z.number().min(0).max(100),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'media.volume',
            label: t('Set volume', 'Imposta il volume'),
            phrase: t(
              'Set the volume of {device} to {volumeLevel}',
              'Imposta il volume di {device} al {volumeLevel}',
            ),
            icon: 'volume-2',
            openArgs: [
              {
                key: 'volumeLevel',
                label: t('Volume', 'Volume'),
                offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
              },
            ],
          },
        ],
      },
    ),
    setMute: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        muted: z.boolean(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'media.mute',
            label: t('Mute', 'Silenzia'),
            phrase: t('Mute {device}', 'Silenzia {device}'),
            icon: 'volume-x',
            args: { muted: true },
          },
          {
            id: 'media.unmute',
            label: t('Unmute', 'Riattiva l’audio'),
            phrase: t('Unmute {device}', 'Riattiva l’audio di {device}'),
            icon: 'volume-2',
            args: { muted: false },
          },
        ],
      },
    ),
    setShuffle: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        shuffle: z.boolean(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'media.shuffleOn',
            label: t('Shuffle on', 'Riproduzione casuale attiva'),
            phrase: t('Turn on shuffle on {device}', 'Attiva la riproduzione casuale su {device}'),
            icon: 'shuffle',
            args: { shuffle: true },
          },
          {
            id: 'media.shuffleOff',
            label: t('Shuffle off', 'Riproduzione casuale spenta'),
            phrase: t(
              'Turn off shuffle on {device}',
              'Disattiva la riproduzione casuale su {device}',
            ),
            icon: 'shuffle',
            args: { shuffle: false },
          },
        ],
      },
    ),
    setRepeat: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        repeat: MediaPlayerRepeatSchema,
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'media.repeat',
            label: t('Set repeat', 'Imposta la ripetizione'),
            phrase: t(
              'Set repeat on {device} to {repeat}',
              'Imposta la ripetizione di {device} su {repeat}',
            ),
            icon: 'repeat',
            openArgs: [
              {
                key: 'repeat',
                label: t('Repeat', 'Ripetizione'),
                offer: {
                  kind: 'enum',
                  values: [
                    { value: 'off', label: t('Off', 'Disattivata') },
                    { value: 'all', label: t('All', 'Tutti i brani') },
                    { value: 'one', label: t('One track', 'Un brano') },
                  ],
                },
              },
            ],
          },
        ],
      },
    ),
    selectSource: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        source: z.string().min(1),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'media.source',
            label: t('Select source', 'Scegli la sorgente'),
            phrase: t('Switch {device} to {source}', 'Passa {device} alla sorgente {source}'),
            icon: 'cast',
            openArgs: [
              {
                key: 'source',
                label: t('Source', 'Sorgente'),
                offer: {
                  kind: 'dynamic',
                  from: 'status',
                  field: 'availableSources',
                },
              },
            ],
          },
        ],
      },
    ),
    seek: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        position: z.number().int().nonnegative(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'media.seek',
            label: t('Seek', 'Vai al punto'),
            phrase: t('Move {device} to {position}', 'Porta {device} al punto {position}'),
            icon: 'fast-forward',
            openArgs: [
              {
                key: 'position',
                label: t('Position', 'Posizione'),
                offer: { kind: 'number', min: 0, step: 1000, unit: 'ms' },
              },
            ],
          },
        ],
      },
    ),
    playMedia: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        /** Media identifier / URL. */
        mediaId: z.string().min(1),
        /** Media kind (`music`, `tvshow`, `movie`, `app`, …) — provider
         *  passes it through to the upstream service. */
        mediaType: z.string().min(1),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'media.playMedia',
            label: t('Play media', 'Riproduci un contenuto'),
            phrase: t('Play {mediaId} on {device}', 'Riproduci {mediaId} su {device}'),
            icon: 'music',
            openArgs: [
              {
                key: 'mediaId',
                label: t('Media', 'Contenuto'),
                offer: { kind: 'text' },
              },
              {
                key: 'mediaType',
                label: t('Media type', 'Tipo di contenuto'),
                offer: { kind: 'text' },
              },
            ],
          },
        ],
      },
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
  vocabulary: {
    noun: t('Media player', 'Lettore multimediale'),
    order: 2060,
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('Playback', 'Riproduzione'),
        values: [
          {
            value: 'off',
            label: t('Off', 'Spento'),
            phrase: t('When {device} turns off', 'Quando {device} si spegne'),
          },
          {
            value: 'on',
            label: t('On', 'Acceso'),
            phrase: t('When {device} turns on', 'Quando {device} si accende'),
          },
          { value: 'idle', label: t('Idle', 'Inattivo') },
          {
            value: 'playing',
            label: t('Playing', 'In riproduzione'),
            phrase: t('When {device} starts playing', 'Quando {device} inizia a riprodurre'),
          },
          {
            value: 'paused',
            label: t('Paused', 'In pausa'),
            phrase: t('When {device} is paused', 'Quando {device} va in pausa'),
          },
          { value: 'buffering', label: t('Buffering', 'In caricamento') },
          { value: 'standby', label: t('Standby', 'In standby') },
        ],
        icon: 'music',
      },
      {
        kind: 'numeric',
        field: 'volumeLevel',
        quantity: t('the volume', 'il volume'),
        label: t('Volume', 'Volume'),
        unit: '%',
        icon: 'volume-2',
      },
      {
        kind: 'boolean',
        field: 'isMuted',
        label: t('Muted', 'Silenziato'),
        whenTrue: t('When {device} is muted', 'Quando {device} viene silenziato'),
        whenFalse: t('When {device} is unmuted', 'Quando l’audio di {device} torna attivo'),
        icon: 'volume-x',
      },
      {
        kind: 'value',
        field: 'source',
        label: t('Source', 'Sorgente'),
        offer: { kind: 'dynamic', from: 'status', field: 'availableSources' },
        icon: 'cast',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IMediaPlayerProvider = InferProvider<typeof mediaPlayerCapability>
