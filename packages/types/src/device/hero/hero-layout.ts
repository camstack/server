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
export const HERO_LAYOUT_DEFAULT: HeroLayout = {
  rows: ['contact', 'motion-trigger'],
}

const HEATER_LAYOUT: HeroLayout = { rows: ['run-for', 'cycle'] }
const MEDIA_PLAYER_LAYOUT: HeroLayout = {
  rows: ['now-playing', 'playback', 'volume', 'channel', 'source', 'do-not-disturb'],
}
const APPLIANCE_LAYOUT: HeroLayout = { rows: ['progress', 'cycle'] }
/** Its Home Connect PowerState is a secondary row action, never the own-power slot. */
const DISHWASHER_LAYOUT: HeroLayout = {
  rows: ['progress', 'cycle', 'program', 'appliance-power'],
}
const CLIMATE_LAYOUT: HeroLayout = {
  rows: ['climate-mode', 'climate-fan', 'setpoint'],
}
const SWITCH_LAYOUT: HeroLayout = { rows: ['motion-trigger'] }
const LOCK_LAYOUT: HeroLayout = { rows: ['lock'] }
const ALARM_LAYOUT: HeroLayout = { rows: ['alarm'] }
const FAN_LAYOUT: HeroLayout = { rows: ['fan'] }
const VACUUM_LAYOUT: HeroLayout = { rows: ['vacuum', 'vacuum-suction'] }
const MOWER_LAYOUT: HeroLayout = { rows: ['mower'] }
const FEEDER_LAYOUT: HeroLayout = { rows: ['feeder'] }
const FOUNTAIN_LAYOUT: HeroLayout = { rows: ['fountain', 'pump-cycle'] }
const AUTOMATION_LAYOUT: HeroLayout = { rows: ['automation'] }
const SCRIPT_LAYOUT: HeroLayout = { rows: ['script'] }
const LIGHT_LAYOUT: HeroLayout = { rows: ['brightness', 'color', 'contact', 'motion-trigger'] }
const COVER_LAYOUT: HeroLayout = { rows: ['cover'] }
const VALVE_LAYOUT: HeroLayout = { rows: ['valve'] }
const HUMIDIFIER_LAYOUT: HeroLayout = { rows: ['humidifier'] }
const UPDATE_LAYOUT: HeroLayout = { rows: ['update'] }
const CONTROL_LAYOUT: HeroLayout = { rows: ['control'] }
const BUTTON_LAYOUT: HeroLayout = { rows: ['button'] }

export const HERO_LAYOUT_BY_TYPE = {
  [DeviceType.Camera]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Hub]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Light]: LIGHT_LAYOUT,
  [DeviceType.Siren]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Switch]: SWITCH_LAYOUT,
  [DeviceType.Sensor]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Thermostat]: CLIMATE_LAYOUT,
  [DeviceType.Climate]: CLIMATE_LAYOUT,
  [DeviceType.Button]: BUTTON_LAYOUT,
  [DeviceType.EventEmitter]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Update]: UPDATE_LAYOUT,
  [DeviceType.Generic]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Notifier]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Script]: SCRIPT_LAYOUT,
  [DeviceType.Automation]: AUTOMATION_LAYOUT,
  [DeviceType.Lock]: LOCK_LAYOUT,
  [DeviceType.Cover]: COVER_LAYOUT,
  [DeviceType.Valve]: VALVE_LAYOUT,
  [DeviceType.Humidifier]: HUMIDIFIER_LAYOUT,
  [DeviceType.WaterHeater]: CLIMATE_LAYOUT,
  [DeviceType.Fan]: FAN_LAYOUT,
  [DeviceType.MediaPlayer]: MEDIA_PLAYER_LAYOUT,
  [DeviceType.AlarmPanel]: ALARM_LAYOUT,
  [DeviceType.Control]: CONTROL_LAYOUT,
  [DeviceType.Presence]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Weather]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Vacuum]: VACUUM_LAYOUT,
  [DeviceType.LawnMower]: MOWER_LAYOUT,
  [DeviceType.Container]: HERO_LAYOUT_DEFAULT,
  [DeviceType.Image]: HERO_LAYOUT_DEFAULT,
  [DeviceType.PetFeeder]: FEEDER_LAYOUT,
  [DeviceType.PetFountain]: FOUNTAIN_LAYOUT,
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
