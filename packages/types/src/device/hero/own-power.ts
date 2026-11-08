/**
 * The ONE resolver behind the device's own-power slot (D1023, Addendum 4).
 *
 * "Power on / off" is not one capability: a switch is `switch.setState`, a
 * media player is `media-player.turnOn` / `turnOff` and only when it declares
 * `MediaPlayerPower`. The slot is reserved uniformly and fed by whichever cap
 * offers it; a renderer never knows which cap is behind it. The plug that FEEDS
 * a device (`power-source`) is a different element and is never offered here.
 */
import type { HeroOwnPowerSlot } from './hero-model.js'

/** The media player's offer outranks a bound switch: the player's own state is the device's. */
const OWN_POWER_SOURCE_ORDER: readonly HeroOwnPowerSlot['source'][] = [
  'media-player',
  'climate-control',
  'switch',
]

export function resolveOwnPower(offers: readonly HeroOwnPowerSlot[]): HeroOwnPowerSlot | null {
  for (const source of OWN_POWER_SOURCE_ORDER) {
    const offer = offers.find((o) => o.source === source)
    if (offer !== undefined) return offer
  }
  return null
}
