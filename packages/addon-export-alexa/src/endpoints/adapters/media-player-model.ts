/**
 * A media player exported as a TV (planning#398). What Alexa is told depends on
 * what the player can DO (its features) and what it REPORTS (its slice):
 *
 *   power      → `Alexa.PowerController`        (feature `media-player-power`)
 *   volume ±N  → `Alexa.StepSpeaker`            (feature `media-player-volume-step`)
 *   mute       → `Alexa.Speaker` (`muted` only) (feature `media-player-mute`)
 *   channel ±N → `Alexa.ChannelController`      (feature `media-player-channel-step`)
 *   transport  → `Alexa.PlaybackController`     (stop / next / previous by feature; play and
 *                                                pause only when the player REPORTS its state,
 *                                                since an assumed one cannot tell)
 *   inputs     → `Alexa.InputController`        (the reported sources Amazon names)
 *
 * A property is reported only for a known value: an assumed `standby`, a null
 * mute and an unlisted volume or input produce no property at all (D393).
 */
import { DeviceFeature, MediaPlayerStatusSchema, type MediaPlayerStatus } from '@camstack/types'
import type { AlexaCapability } from '../types.js'
import { iface } from './shared.js'
import type { AdapterDevice, GenericProperty } from './types.js'

export const CAP_MEDIA_PLAYER = 'media-player'

/** The input names Amazon accepts for `Alexa.InputController` (alexa-inputcontroller). */
const AMAZON_INPUTS: readonly string[] = [
  ...Array.from({ length: 7 }, (_, i) => `AUX ${i + 1}`),
  'BLURAY',
  'CABLE',
  'CD',
  'COAX 1',
  'COAX 2',
  'COMPOSITE 1',
  'DVD',
  'GAME',
  'HD RADIO',
  ...Array.from({ length: 10 }, (_, i) => `HDMI ${i + 1}`),
  'HDMI ARC',
  ...Array.from({ length: 10 }, (_, i) => `INPUT ${i + 1}`),
  'IPOD',
  ...Array.from({ length: 7 }, (_, i) => `LINE ${i + 1}`),
  'MEDIA PLAYER',
  'OPTICAL 1',
  'OPTICAL 2',
  'PHONO',
  'PLAYSTATION',
  'PLAYSTATION 3',
  'PLAYSTATION 4',
  'SATELLITE',
  'SMARTCAST',
  'TUNER',
  'TV',
  'USB',
  'USB DAC',
  'VIDEO 1',
  'VIDEO 2',
  'VIDEO 3',
  'XBOX',
]

function squash(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** The Amazon input a source name stands for ("hdmi1" → "HDMI 1"), or null. */
export function amazonInputOf(source: string): string | null {
  const wanted = squash(source)
  return AMAZON_INPUTS.find((name) => squash(name) === wanted) ?? null
}

/** The sources of a slice that Amazon has a name for, paired with the player's own name. */
export function inputPairs(
  status: MediaPlayerStatus,
): ReadonlyArray<{ readonly amazon: string; readonly source: string }> {
  const seen = new Set<string>()
  const pairs: Array<{ amazon: string; source: string }> = []
  for (const source of status.availableSources) {
    const amazon = amazonInputOf(source)
    if (amazon === null || seen.has(amazon)) continue
    seen.add(amazon)
    pairs.push({ amazon, source })
  }
  return pairs
}

export function readMediaPlayerSlice(slice: unknown): MediaPlayerStatus | null {
  const parsed = MediaPlayerStatusSchema.safeParse(slice)
  return parsed.success ? parsed.data : null
}

const PLAYBACK_BY_FEATURE: ReadonlyArray<readonly [DeviceFeature, string]> = [
  [DeviceFeature.MediaPlayerStop, 'Stop'],
  [DeviceFeature.MediaPlayerNext, 'Next'],
  [DeviceFeature.MediaPlayerPrevious, 'Previous'],
]

export function playbackOperations(
  device: AdapterDevice,
  status: MediaPlayerStatus | null,
): readonly string[] {
  const reported = status !== null && status.stateSource === 'reported'
  return [
    ...(reported ? ['Play', 'Pause'] : []),
    ...PLAYBACK_BY_FEATURE.filter(([feature]) => device.features.includes(feature)).map(
      ([, operation]) => operation,
    ),
  ]
}

export function describeMediaPlayerCapabilities(device: AdapterDevice): readonly AlexaCapability[] {
  const has = (feature: DeviceFeature): boolean => device.features.includes(feature)
  const status = readMediaPlayerSlice(device.slices[CAP_MEDIA_PLAYER])
  const capabilities: AlexaCapability[] = []
  if (has(DeviceFeature.MediaPlayerPower))
    capabilities.push(iface('Alexa.PowerController', 'powerState'))
  if (has(DeviceFeature.MediaPlayerVolumeStep)) {
    capabilities.push({
      type: 'AlexaInterface',
      interface: 'Alexa.StepSpeaker',
      version: '3',
    })
  }
  if (has(DeviceFeature.MediaPlayerMute)) capabilities.push(iface('Alexa.Speaker', 'muted'))
  if (has(DeviceFeature.MediaPlayerChannelStep)) {
    capabilities.push({
      type: 'AlexaInterface',
      interface: 'Alexa.ChannelController',
      version: '3',
    })
  }
  const operations = playbackOperations(device, status)
  if (operations.length > 0) {
    capabilities.push({
      type: 'AlexaInterface',
      interface: 'Alexa.PlaybackController',
      version: '3',
      supportedOperations: operations,
    })
  }
  const inputs = status === null ? [] : inputPairs(status)
  if (has(DeviceFeature.MediaPlayerSelectSource) && inputs.length > 0) {
    capabilities.push({
      ...iface('Alexa.InputController', 'input'),
      inputs: inputs.map((i) => ({ name: i.amazon })),
    })
  }
  return capabilities
}

/** The Alexa properties of a slice: only what is known. */
export function mediaPlayerProperties(slice: unknown): readonly GenericProperty[] {
  const status = readMediaPlayerSlice(slice)
  if (status === null) return []
  const out: GenericProperty[] = []
  if (status.state === 'off') {
    out.push({
      namespace: 'Alexa.PowerController',
      name: 'powerState',
      value: 'OFF',
    })
  } else if (status.state !== 'standby') {
    out.push({
      namespace: 'Alexa.PowerController',
      name: 'powerState',
      value: 'ON',
    })
  }
  if (status.isMuted !== null) {
    out.push({
      namespace: 'Alexa.Speaker',
      name: 'muted',
      value: status.isMuted,
    })
  }
  const input = inputPairs(status).find((i) => i.source === status.source)
  if (input !== undefined) {
    out.push({
      namespace: 'Alexa.InputController',
      name: 'input',
      value: input.amazon,
    })
  }
  return out
}
