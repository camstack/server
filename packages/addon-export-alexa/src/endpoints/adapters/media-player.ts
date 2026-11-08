import {
  claimsMediaPlayerPower,
  handleMediaPlayerDirective,
} from '../../handlers/media-player-controller.js'
import {
  CAP_MEDIA_PLAYER,
  describeMediaPlayerCapabilities,
  mediaPlayerProperties,
} from './media-player-model.js'
import type { AdapterDirective, GenericAdapter } from './types.js'

function directive(key: string, claims?: AdapterDirective['claims']): AdapterDirective {
  return {
    key,
    needsReachableDevice: true,
    handle: handleMediaPlayerDirective,
    ...(claims === undefined ? {} : { claims }),
  }
}

const DIRECTIVES: readonly AdapterDirective[] = [
  directive('Alexa.PowerController/TurnOn', claimsMediaPlayerPower),
  directive('Alexa.PowerController/TurnOff', claimsMediaPlayerPower),
  directive('Alexa.StepSpeaker/AdjustVolume'),
  directive('Alexa.StepSpeaker/SetMute'),
  directive('Alexa.Speaker/SetMute'),
  directive('Alexa.ChannelController/SkipChannels'),
  directive('Alexa.ChannelController/ChangeChannel'),
  directive('Alexa.PlaybackController/Play'),
  directive('Alexa.PlaybackController/Pause'),
  directive('Alexa.PlaybackController/Stop'),
  directive('Alexa.PlaybackController/Next'),
  directive('Alexa.PlaybackController/Previous'),
  directive('Alexa.InputController/SelectInput'),
]

/**
 * `media-player` → a TV: power, step volume, mute, channel steps, transport and
 * inputs, each only when the player says it can (features) and, for the ones
 * that need a reading, only when it reports one. Registered before `switch`: a
 * TV is a TV, not a SWITCH.
 */
export const mediaPlayerAdapter: GenericAdapter = {
  cap: CAP_MEDIA_PLAYER,
  stateCaps: [CAP_MEDIA_PLAYER],
  discoveryReads: [CAP_MEDIA_PLAYER],
  describe: (device) => {
    const capabilities = describeMediaPlayerCapabilities(device)
    if (capabilities.length === 0) {
      return {
        kind: 'skip',
        reason: 'the media player offers nothing Alexa can drive',
      }
    }
    return { kind: 'publish', capabilities, category: 'TV' }
  },
  properties: (_cap, slice) => mediaPlayerProperties(slice),
  directives: DIRECTIVES,
  shaping: () => null,
}
