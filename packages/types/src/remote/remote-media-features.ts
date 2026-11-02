/**
 * Which media-player surfaces a remote's BOUND roles give a device (D967
 * amendment). A television driven by infrared reports nothing, so its surface is
 * exactly what the operator wired: a bound `volume_up` is `VolumeStep`, never a
 * level. One mapping, read by the composer (the device's `features`) and by an
 * exporter deciding what to offer.
 */
import { DeviceFeature } from '../device/device-type.js'
import { customKeyOfRole } from './remote-roles.js'

const FEATURE_ROLES: readonly (readonly [DeviceFeature, readonly string[]])[] = [
  [DeviceFeature.MediaPlayerPower, ['power', 'power_on', 'power_off']],
  [DeviceFeature.MediaPlayerVolumeStep, ['volume_up', 'volume_down']],
  [DeviceFeature.MediaPlayerChannelStep, ['channel_up', 'channel_down']],
  [DeviceFeature.MediaPlayerMute, ['mute']],
  [DeviceFeature.MediaPlayerStop, ['stop']],
  [DeviceFeature.MediaPlayerNext, ['next']],
  [DeviceFeature.MediaPlayerPrevious, ['previous']],
]

/** The features the bound roles stand for, in a stable order. */
export function mediaPlayerFeaturesOfRoles(roles: readonly string[]): readonly DeviceFeature[] {
  const bound = new Set(roles)
  const fixed = FEATURE_ROLES.filter(([, wanted]) => wanted.some((role) => bound.has(role))).map(
    ([feature]) => feature,
  )
  const hasSource = roles.some((role) => role === 'input' || customKeyOfRole(role) !== null)
  return hasSource ? [...fixed, DeviceFeature.MediaPlayerSelectSource] : fixed
}
