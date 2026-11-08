/**
 * The FIXED layout of each device type's hero (D1023). A layout lives in this
 * file and nowhere else: there are no overrides, no editors and no store.
 *
 * A layout names only the ROWS a type carries, in order. The base slots —
 * the remote button, consumables, consumption, the device's own power with
 * its timed run beside it, and the power supply — are not here, so no layout
 * can hide one (Addendum 6): they appear whenever the device has the cap.
 * A row whose caps the device is not bound to is simply absent.
 */
import { DeviceType } from '../device-type.js'
import type { HeroRowId } from './hero-model.js'

export interface HeroLayout {
  readonly rows: readonly HeroRowId[]
}

/** Every other type: the facts a bound cap adds, nothing type-specific. */
export const HERO_LAYOUT_DEFAULT: HeroLayout = { rows: ['contact', 'motion-trigger'] }

const HEATER_LAYOUT: HeroLayout = { rows: ['run-for', 'cycle'] }
const MEDIA_PLAYER_LAYOUT: HeroLayout = {
  rows: ['now-playing', 'playback', 'volume', 'source'],
}
const APPLIANCE_LAYOUT: HeroLayout = { rows: ['cycle'] }
/** Its Home Connect PowerState is a secondary row action, never the own-power slot. */
const DISHWASHER_LAYOUT: HeroLayout = { rows: ['cycle', 'program', 'appliance-power'] }
const SWITCH_LAYOUT: HeroLayout = { rows: ['motion-trigger'] }

export const HERO_LAYOUT_BY_TYPE = {
  [DeviceType.Camera]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Hub]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Light]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Siren]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Switch]: SWITCH_LAYOUT,
  [DeviceType.Sensor]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Thermostat]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Climate]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Button]: HERO_LAYOUT_DEFAULT,
  [DeviceType.EventEmitter]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Update]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Generic]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Notifier]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Script]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Automation]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Lock]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Cover]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Valve]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Humidifier]: HERO_LAYOUT_DEFAULT,
  [DeviceType.WaterHeater]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Fan]: HERO_LAYOUT_DEFAULT,
  [DeviceType.MediaPlayer]: MEDIA_PLAYER_LAYOUT,
  [DeviceType.AlarmPanel]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Control]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Presence]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Weather]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Vacuum]: HERO_LAYOUT_DEFAULT,
  [DeviceType.LawnMower]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Container]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Image]: HERO_LAYOUT_DEFAULT,
  [DeviceType.PetFeeder]: HERO_LAYOUT_DEFAULT,
  [DeviceType.PetFountain]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Dishwasher]: DISHWASHER_LAYOUT,
  [DeviceType.Washer]: APPLIANCE_LAYOUT,
  [DeviceType.Heater]: HEATER_LAYOUT,
  [DeviceType.Dryer]: APPLIANCE_LAYOUT,
  [DeviceType.Gateway]: HERO_LAYOUT_DEFAULT,
} as const satisfies Record<DeviceType, HeroLayout>

function isDeviceType(type: string): type is DeviceType {
  return Object.values<string>(DeviceType).includes(type)
}

/** The layout of a type; a type this build does not know gets the default. */
export function resolveHeroLayout(type: string): HeroLayout {
  return isDeviceType(type) ? HERO_LAYOUT_BY_TYPE[type] : HERO_LAYOUT_DEFAULT
}
