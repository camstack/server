/**
 * Who looks like what (D1023). One look per {@link DeviceType}, refined by a
 * {@link DeviceRole} where the role changes how the device reads (a leak
 * sensor is not a generic sensor). Resolution is role, then type, then the
 * generic default — the order the cap vocabulary uses.
 *
 * Exhaustive twice: the records are `satisfies Record<…>` over the enums, so a
 * new member fails the build here; `scripts/check-hero-look-exhaustive.ts`
 * re-checks at runtime (a `Partial` sneaking in through a cast) and that every
 * icon is in the catalog.
 *
 * ONE animation per state — the card runs a single background animation plus
 * its icon, nothing else.
 */
import { isAirConditioner } from '../device-kind.js'
import { DeviceRole, DeviceType } from '../device-type.js'
import type { VocabIcon } from './cap-vocabulary-icon.js'
import type { HeroSceneMode } from './hero-scene.js'
import type {
  HeroAnimation,
  HeroBackgroundToken,
  HeroLook,
  HeroState,
  HeroTone,
  StateLook,
} from './hero-state.js'

function look(
  icon: VocabIcon,
  tone: HeroTone,
  background: HeroBackgroundToken,
  animation: HeroAnimation,
): StateLook {
  return { icon, tone, background, animation }
}

/** Unreachable: identical for every look. */
const OFFLINE = look('wifi-off', 'muted', 'plain', 'none')
const ALERT = look('triangle-alert', 'danger', 'alert-wash', 'pulse')

/** What a look chooses per type: the icon, and how the five operating states read. */
interface LookSpec {
  readonly icon: VocabIcon
  readonly on: readonly [HeroTone, HeroBackgroundToken, HeroAnimation]
  readonly off: readonly [HeroTone, HeroBackgroundToken, HeroAnimation]
  readonly running: readonly [HeroTone, HeroBackgroundToken, HeroAnimation]
  readonly idle: readonly [HeroTone, HeroBackgroundToken, HeroAnimation]
  readonly standby: readonly [HeroTone, HeroBackgroundToken, HeroAnimation]
  readonly alert?: StateLook
}

function lookOf(spec: LookSpec): HeroLook {
  const at = (s: readonly [HeroTone, HeroBackgroundToken, HeroAnimation]): StateLook =>
    look(spec.icon, s[0], s[1], s[2])
  return {
    on: at(spec.on),
    off: at(spec.off),
    running: at(spec.running),
    idle: at(spec.idle),
    standby: at(spec.standby),
    alert: spec.alert ?? ALERT,
    offline: OFFLINE,
    // Not reported yet: the device's own icon, quiet — its normal card with an
    // empty value, never a question mark standing in for it (D393).
    unknown: look(spec.icon, 'muted', 'plain', 'none'),
  }
}

const MUTED = ['muted', 'plain', 'none'] as const
const INFO = ['info', 'plain', 'none'] as const
const WARN = ['warning', 'plain', 'none'] as const

/** The generic look: every state declared, nothing opinionated. */
export const HERO_LOOK_DEFAULT: HeroLook = lookOf({
  icon: 'power',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const SWITCH_LOOK = lookOf({
  icon: 'power',
  on: ['success', 'glow', 'glow'],
  off: MUTED,
  running: ['success', 'glow', 'glow'],
  idle: INFO,
  standby: WARN,
})

/** A heater heats: warm air rises while it draws, nothing moves when it is off. */
const HEATER_LOOK = lookOf({
  icon: 'flame',
  on: ['warning', 'heat-rise', 'rise'],
  off: MUTED,
  running: ['warning', 'heat-rise', 'rise'],
  idle: INFO,
  standby: MUTED,
})

const MEDIA_PLAYER_LOOK = lookOf({
  icon: 'tv',
  on: ['success', 'glow', 'halo'],
  off: MUTED,
  running: ['success', 'glow', 'equalizer'],
  idle: ['success', 'glow', 'halo'],
  standby: WARN,
})

/** A drum that tumbles only while a cycle runs. */
const WASHER_LOOK = lookOf({
  icon: 'washing-machine',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'drum', 'tumble'],
  idle: INFO,
  standby: WARN,
})

const DRYER_LOOK = lookOf({
  icon: 'wind',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'drum', 'tumble'],
  idle: INFO,
  standby: WARN,
})

const DISHWASHER_LOOK = lookOf({
  icon: 'utensils',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'water', 'wave'],
  idle: INFO,
  standby: WARN,
})

/** A sensor that reads Clear or Detected: calm when clear, an alarm when it trips. */
function sensorLook(icon: VocabIcon, alertIcon: VocabIcon = icon): HeroLook {
  return lookOf({
    icon,
    on: ['primary', 'glow', 'halo'],
    off: MUTED,
    running: ['primary', 'glow', 'halo'],
    idle: ['success', 'plain', 'none'],
    standby: WARN,
    alert: look(alertIcon, 'danger', 'alert-wash', 'pulse'),
  })
}

const LEAK_LOOK = sensorLook('droplets')
const SMOKE_LOOK = sensorLook('flame')
const GAS_LOOK = sensorLook('wind')
const TAMPER_LOOK = sensorLook('shield-alert')
const VIBRATION_LOOK = sensorLook('vibrate')
const MOTION_LOOK = sensorLook('radar', 'triangle-alert')
const DOORBELL_LOOK = sensorLook('bell-ring')

/** A camera is a camera: never a power glyph, whatever its motion reads. */
const CAMERA_LOOK = sensorLook('video', 'triangle-alert')

/** A bulb glows while lit. */
const LIGHT_LOOK = lookOf({
  icon: 'lightbulb',
  on: ['warning', 'glow', 'glow'],
  off: MUTED,
  running: ['warning', 'glow', 'glow'],
  idle: INFO,
  standby: WARN,
})

/** Closed is a position, not an absence of power: the blind keeps its glyph and goes quiet. */
const COVER_LOOK = lookOf({
  icon: 'blinds',
  on: ['primary', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const VALVE_LOOK = lookOf({
  icon: 'droplet',
  on: ['primary', 'water', 'wave'],
  off: MUTED,
  running: ['primary', 'water', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const HUMIDIFIER_LOOK = lookOf({
  icon: 'droplets',
  on: ['info', 'mist', 'breathe'],
  off: MUTED,
  running: ['info', 'mist', 'wave'],
  idle: INFO,
  standby: WARN,
})

const CONTROL_LOOK = lookOf({
  icon: 'sliders-horizontal',
  on: ['primary', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const PRESENCE_LOOK = lookOf({
  icon: 'map-pin',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const WEATHER_LOOK = lookOf({
  icon: 'cloud-sun',
  on: ['info', 'sky', 'none'],
  off: MUTED,
  running: ['info', 'sky', 'none'],
  idle: INFO,
  standby: WARN,
})

/** An update waits (warning), runs (pulse) or is done (calm). */
const UPDATE_LOOK = lookOf({
  icon: 'download',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: ['success', 'plain', 'none'],
  standby: ['warning', 'plain', 'pulse'],
})

const BUTTON_LOOK = lookOf({
  icon: 'pointer',
  on: ['primary', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const IMAGE_LOOK = lookOf({
  icon: 'image',
  on: ['primary', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

/** A lock is secure when locked, and says so when it is not. */
const LOCK_LOOK: HeroLook = {
  ...lookOf({
    icon: 'lock',
    on: ['success', 'plain', 'none'],
    off: MUTED,
    running: ['primary', 'plain', 'pulse'],
    idle: INFO,
    standby: WARN,
  }),
  standby: look('lock-open', 'warning', 'plain', 'none'),
  off: look('lock-open', 'muted', 'plain', 'none'),
}

/** The shield glows red while armed, blinks red in alarm and goes quiet when disarmed. */
const ALARM_LOOK: HeroLook = {
  ...lookOf({
    icon: 'shield-check',
    on: ['danger', 'glow', 'halo'],
    off: MUTED,
    running: ['primary', 'plain', 'pulse'],
    idle: INFO,
    standby: WARN,
  }),
  off: look('shield-off', 'muted', 'plain', 'none'),
  standby: look('shield', 'warning', 'plain', 'pulse'),
  alert: look('shield-alert', 'danger', 'alert-wash', 'blink'),
}

/** Blades turn only while air moves. */
const FAN_LOOK = lookOf({
  icon: 'fan',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'mist', 'spin'],
  idle: INFO,
  standby: WARN,
})

const VACUUM_LOOK = lookOf({
  icon: 'bot',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const MOWER_LOOK = lookOf({
  icon: 'sprout',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const FEEDER_LOOK = lookOf({
  icon: 'bone',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const FOUNTAIN_LOOK = lookOf({
  icon: 'droplets',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'water', 'wave'],
  idle: INFO,
  standby: WARN,
})

const AUTOMATION_LOOK = lookOf({
  icon: 'workflow',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const SCRIPT_LOOK = lookOf({
  icon: 'scroll-text',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

const EVENT_EMITTER_LOOK = lookOf({
  icon: 'radio-tower',
  on: ['success', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'pulse'],
  idle: INFO,
  standby: WARN,
})

/** A reading device: the value is the headline, the look only says what kind of reading it is. */
function readingLook(icon: VocabIcon, tone: HeroTone): HeroLook {
  return lookOf({
    icon,
    on: [tone, 'plain', 'none'],
    off: MUTED,
    running: [tone, 'plain', 'none'],
    idle: [tone, 'plain', 'none'],
    standby: MUTED,
  })
}

const READING_SENSOR_LOOK = readingLook('gauge', 'info')
const TEMPERATURE_LOOK = readingLook('thermometer', 'info')
const HUMIDITY_LOOK = readingLook('droplets', 'info')
const AIR_QUALITY_LOOK = readingLook('wind', 'success')
const LIGHT_SENSOR_LOOK = readingLook('sun', 'warning')

/** Carbon monoxide: calm is a shield, detected is the alarm. */
const CO_LOOK = lookOf({
  icon: 'shield-check',
  on: ['danger', 'alert-wash', 'pulse'],
  off: MUTED,
  running: ['danger', 'alert-wash', 'pulse'],
  idle: ['success', 'plain', 'none'],
  standby: MUTED,
  alert: look('triangle-alert', 'danger', 'alert-wash', 'pulse'),
})

/** Heating and cooling devices: the mode (see {@link HERO_MODE_LOOK}) picks the picture while on. */
const THERMOSTAT_LOOK = lookOf({
  icon: 'thermometer',
  on: ['primary', 'plain', 'none'],
  off: MUTED,
  running: ['warning', 'heat-rise', 'rise'],
  idle: INFO,
  standby: MUTED,
})

const CLIMATE_LOOK = lookOf({
  icon: 'snowflake',
  on: ['primary', 'plain', 'none'],
  off: MUTED,
  running: ['primary', 'plain', 'none'],
  idle: INFO,
  standby: MUTED,
})

const WATER_HEATER_LOOK = lookOf({
  icon: 'thermometer-sun',
  on: ['warning', 'heat-rise', 'rise'],
  off: MUTED,
  running: ['warning', 'heat-rise', 'rise'],
  idle: INFO,
  standby: MUTED,
})

const HEAT_PUMP_LOOK = lookOf({
  icon: 'thermometer-sun',
  on: ['warning', 'heat-rise', 'rise'],
  off: MUTED,
  running: ['warning', 'heat-rise', 'rise'],
  idle: INFO,
  standby: MUTED,
})

/** What a climate device draws while it is on, by mode: warm air rises, cold falls, drops dry, the fan spins. */
export const HERO_MODE_LOOK: Readonly<Record<HeroSceneMode, StateLook | null>> = {
  heat: look('flame', 'warning', 'heat-rise', 'rise'),
  cool: look('snowflake', 'info', 'cool-fall', 'fall'),
  dry: look('droplets', 'info', 'water', 'wave'),
  fan: look('fan', 'primary', 'plain', 'spin'),
  auto: look('thermometer', 'success', 'glow', 'glow'),
  playing: null,
  paused: null,
  open: null,
  closed: null,
}

const MODE_LOOK_TYPES: readonly string[] = [DeviceType.Climate]

export const HERO_LOOK_BY_TYPE = {
  [DeviceType.Camera]: CAMERA_LOOK,
  [DeviceType.Light]: LIGHT_LOOK,
  [DeviceType.Siren]: HERO_LOOK_DEFAULT,
  [DeviceType.Switch]: SWITCH_LOOK,
  [DeviceType.Sensor]: READING_SENSOR_LOOK,
  [DeviceType.Climate]: THERMOSTAT_LOOK,
  [DeviceType.Button]: BUTTON_LOOK,
  [DeviceType.EventEmitter]: EVENT_EMITTER_LOOK,
  [DeviceType.Update]: UPDATE_LOOK,
  [DeviceType.Generic]: HERO_LOOK_DEFAULT,
  [DeviceType.Notifier]: HERO_LOOK_DEFAULT,
  [DeviceType.Script]: SCRIPT_LOOK,
  [DeviceType.Automation]: AUTOMATION_LOOK,
  [DeviceType.Lock]: LOCK_LOOK,
  [DeviceType.Cover]: COVER_LOOK,
  [DeviceType.Valve]: VALVE_LOOK,
  [DeviceType.Humidifier]: HUMIDIFIER_LOOK,
  [DeviceType.WaterHeater]: WATER_HEATER_LOOK,
  [DeviceType.HeatPump]: HEAT_PUMP_LOOK,
  [DeviceType.EnergySystem]: HERO_LOOK_DEFAULT,
  [DeviceType.Fan]: FAN_LOOK,
  [DeviceType.MediaPlayer]: MEDIA_PLAYER_LOOK,
  [DeviceType.AlarmPanel]: ALARM_LOOK,
  [DeviceType.Control]: CONTROL_LOOK,
  [DeviceType.Presence]: PRESENCE_LOOK,
  [DeviceType.Weather]: WEATHER_LOOK,
  [DeviceType.Vacuum]: VACUUM_LOOK,
  [DeviceType.LawnMower]: MOWER_LOOK,
  [DeviceType.Container]: HERO_LOOK_DEFAULT,
  [DeviceType.Image]: IMAGE_LOOK,
  [DeviceType.PetFeeder]: FEEDER_LOOK,
  [DeviceType.PetFountain]: FOUNTAIN_LOOK,
  [DeviceType.Dishwasher]: DISHWASHER_LOOK,
  [DeviceType.Washer]: WASHER_LOOK,
  [DeviceType.Dryer]: DRYER_LOOK,
  [DeviceType.Gateway]: HERO_LOOK_DEFAULT,
} as const satisfies Record<DeviceType, HeroLook>

/** `inherit` = take the type's look. A role only REFINES a type; it never replaces the type system. */
export const HERO_LOOK_BY_ROLE = {
  [DeviceRole.Siren]: 'inherit',
  [DeviceRole.Floodlight]: 'inherit',
  [DeviceRole.Spotlight]: 'inherit',
  [DeviceRole.PirSensor]: MOTION_LOOK,
  [DeviceRole.Chime]: 'inherit',
  [DeviceRole.Autotrack]: 'inherit',
  [DeviceRole.Nightvision]: 'inherit',
  [DeviceRole.PrivacyMask]: 'inherit',
  [DeviceRole.Doorbell]: DOORBELL_LOOK,
  [DeviceRole.CoverBlind]: 'inherit',
  [DeviceRole.CoverShutter]: 'inherit',
  [DeviceRole.CoverAwning]: 'inherit',
  [DeviceRole.CoverCurtain]: 'inherit',
  [DeviceRole.CoverGarage]: 'inherit',
  [DeviceRole.CoverGate]: 'inherit',
  [DeviceRole.CoverDoor]: 'inherit',
  [DeviceRole.CoverWindow]: 'inherit',
  [DeviceRole.BinaryHelper]: 'inherit',
  [DeviceRole.Outlet]: 'inherit',
  [DeviceRole.SwitchHeater]: HEATER_LOOK,
  [DeviceRole.SwitchFan]: FAN_LOOK,
  [DeviceRole.SwitchLight]: LIGHT_LOOK,
  // An air conditioner draws its MODE when on, so its look is picked after the
  // mode (`resolveHeroLook`), not here where a role beats the mode.
  [DeviceRole.ClimateAc]: 'inherit',
  [DeviceRole.ClimateThermostat]: 'inherit',
  [DeviceRole.ClimateFloor]: 'inherit',
  [DeviceRole.ClimateRadiator]: 'inherit',
  [DeviceRole.ClimateHeater]: 'inherit',
  [DeviceRole.ClimateHeatPumpCircuit]: 'inherit',
  [DeviceRole.MotionSensor]: MOTION_LOOK,
  [DeviceRole.ContactSensor]: 'inherit',
  [DeviceRole.LeakSensor]: LEAK_LOOK,
  [DeviceRole.SmokeSensor]: SMOKE_LOOK,
  [DeviceRole.COSensor]: CO_LOOK,
  [DeviceRole.GasSensor]: GAS_LOOK,
  [DeviceRole.TamperSensor]: TAMPER_LOOK,
  [DeviceRole.VibrationSensor]: VIBRATION_LOOK,
  [DeviceRole.ConnectivitySensor]: 'inherit',
  [DeviceRole.SoundSensor]: 'inherit',
  [DeviceRole.BinarySensor]: 'inherit',
  [DeviceRole.TemperatureSensor]: TEMPERATURE_LOOK,
  [DeviceRole.HumiditySensor]: HUMIDITY_LOOK,
  [DeviceRole.AmbientLightSensor]: LIGHT_SENSOR_LOOK,
  [DeviceRole.PressureSensor]: READING_SENSOR_LOOK,
  [DeviceRole.WindSensor]: 'inherit',
  [DeviceRole.RainSensor]: 'inherit',
  [DeviceRole.UvSensor]: 'inherit',
  [DeviceRole.SolarRadiationSensor]: 'inherit',
  [DeviceRole.SoilMoistureSensor]: 'inherit',
  [DeviceRole.PowerSensor]: 'inherit',
  [DeviceRole.EnergySensor]: 'inherit',
  [DeviceRole.VoltageSensor]: 'inherit',
  [DeviceRole.CurrentSensor]: 'inherit',
  [DeviceRole.AirQualitySensor]: AIR_QUALITY_LOOK,
  [DeviceRole.BatterySensor]: 'inherit',
  [DeviceRole.NumericSensor]: 'inherit',
  [DeviceRole.EnumSensor]: 'inherit',
  [DeviceRole.DateTimeSensor]: 'inherit',
  [DeviceRole.GenericSensor]: 'inherit',
  [DeviceRole.NumericControl]: 'inherit',
  [DeviceRole.SelectControl]: 'inherit',
  [DeviceRole.TextControl]: 'inherit',
  [DeviceRole.DateTimeControl]: 'inherit',
  [DeviceRole.MobilePushNotifier]: 'inherit',
  [DeviceRole.MessagingNotifier]: 'inherit',
  [DeviceRole.EmailNotifier]: 'inherit',
  [DeviceRole.GenericNotifier]: 'inherit',
  [DeviceRole.IrTransmitter]: 'inherit',
} as const satisfies Record<DeviceRole, HeroLook | 'inherit'>

function isDeviceType(type: string): type is DeviceType {
  return Object.values<string>(DeviceType).includes(type)
}

function isDeviceRole(role: string): role is DeviceRole {
  return Object.values<string>(DeviceRole).includes(role)
}

/**
 * The look of a (role, type) pair, for a state. Role beats type beats the generic default.
 * A climate device that is on draws its MODE (`mode` is the scene's); a role never loses to it.
 */
export function resolveHeroLook(
  role: string | null,
  type: string,
  state: HeroState,
  mode: HeroSceneMode | null = null,
): StateLook {
  const byRole = role !== null && isDeviceRole(role) ? HERO_LOOK_BY_ROLE[role] : undefined
  if (byRole !== undefined && byRole !== 'inherit') return byRole[state]
  if (mode !== null && (state === 'on' || state === 'running') && MODE_LOOK_TYPES.includes(type)) {
    const byMode = HERO_MODE_LOOK[mode]
    if (byMode !== null) return byMode
  }
  if (isAirConditioner(type, role)) return CLIMATE_LOOK[state]
  const byType = isDeviceType(type) ? HERO_LOOK_BY_TYPE[type] : undefined
  return (byType ?? HERO_LOOK_DEFAULT)[state]
}

/** Every look the model declares, for the exhaustiveness guard and its spec. */
export function allHeroLooks(): readonly HeroLook[] {
  return [
    HERO_LOOK_DEFAULT,
    ...Object.values(HERO_LOOK_BY_TYPE),
    ...Object.values(HERO_LOOK_BY_ROLE).filter((l): l is HeroLook => l !== 'inherit'),
  ]
}
