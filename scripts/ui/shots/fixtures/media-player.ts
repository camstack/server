/**
 * The media-player hero card. `/devices/961` is an Echo playing a track (title,
 * artist, album, artwork, source, position and duration, shuffle and repeat
 * reported), `/devices/962` an idle Echo with nothing playing. Load BEFORE
 * `helpers` (`--fixtures media-player,helpers`): the first area answering a path
 * wins, and every other path falls through to it.
 */
import { DeviceFeature } from '../../../../packages/types/src/device/device-type.ts'
import helpersArea from './helpers'
import { defineFixtures } from './_define'

const ADDON = 'provider-alexa'

// A neutral cover drawn inline so the shot needs no network.
const COVER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#8a8f98"/><circle cx="80" cy="80" r="46" fill="#5b6068"/><circle cx="80" cy="80" r="10" fill="#8a8f98"/></svg>',
  )

const FEATURES = [
  DeviceFeature.MediaPlayerVolume,
  DeviceFeature.MediaPlayerMute,
  DeviceFeature.MediaPlayerNext,
  DeviceFeature.MediaPlayerPrevious,
]

const device = (id: number, name: string, stableId: string) => ({
  id,
  stableId,
  addonId: ADDON,
  type: 'media-player',
  name,
  location: 'Living room',
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: FEATURES,
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const STATUS_BASE = {
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: 35,
  isMuted: false,
  availableSources: [],
  lastChangedAt: 1,
}

const SLICES: Readonly<Record<number, Record<string, unknown>>> = {
  961: {
    ...STATUS_BASE,
    state: 'playing',
    source: 'Spotify',
    currentMedia: {
      type: 'music',
      title: 'Blue in Green',
      artist: 'Miles Davis',
      album: 'Kind of Blue',
      imageUrl: COVER,
    },
    position: 98_000,
    duration: 337_000,
    shuffle: true,
    repeat: 'all',
  },
  962: {
    ...STATUS_BASE,
    state: 'idle',
    source: '',
    currentMedia: null,
    position: null,
    duration: null,
    shuffle: null,
    repeat: null,
  },
}

const DEVICES = [
  device(961, 'Kitchen Echo', 'echo.kitchen'),
  device(962, 'Bedroom Echo', 'echo.bed'),
]

const base = (path: string): ((i: unknown) => unknown) => {
  const h = helpersArea.handlers[path]
  return typeof h === 'function' ? (i: unknown) => (h as (x: unknown) => unknown)(i) : () => h
}
const isOurs = (id: number | undefined): boolean => id !== undefined && id in SLICES

export default defineFixtures({
  area: 'media-player',
  description: 'Media-player hero card: an Echo playing a track, and an idle Echo',
  handlers: {
    'deviceManager.listAll': (i: { addonId?: string }) => [
      ...(base('deviceManager.listAll')(i) as unknown[]),
      ...DEVICES.filter((d) => i.addonId === undefined || d.addonId === i.addonId),
    ],
    'deviceManager.getDevice': (i: { deviceId?: number }) =>
      DEVICES.find((d) => d.id === i.deviceId) ?? base('deviceManager.getDevice')(i),
    'deviceManager.getBindings': (i: { deviceId?: number }) =>
      isOurs(i.deviceId)
        ? {
            deviceId: i.deviceId ?? 0,
            entries: ['media-player', 'device-status'].map((capName) => ({
              capName,
              kind: 'native' as const,
              providerAddonId: ADDON,
              providerNodeId: 'hub',
              nativeAddonId: ADDON,
            })),
          }
        : base('deviceManager.getBindings')(i),
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'deviceManager.getChildren': [],
    'powerSource.getStatus': {
      linked: false,
      switchDeviceId: null,
      switchName: null,
      switchOn: null,
      switchOnline: null,
      restartInProgress: false,
      offSeconds: 0,
    },
    'preferences.get': { rows: [] },
    'deviceState.getSnapshot': (i: { deviceId?: number }) =>
      isOurs(i.deviceId)
        ? { 'media-player': SLICES[i.deviceId ?? 0] }
        : base('deviceState.getSnapshot')(i),
    'deviceState.getCapSlice': (i: { deviceId?: number; capName?: string }) =>
      isOurs(i.deviceId) && i.capName === 'media-player'
        ? SLICES[i.deviceId ?? 0]
        : isOurs(i.deviceId)
          ? {}
          : base('deviceState.getCapSlice')(i),
  },
})
