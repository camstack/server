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
import { DeviceRole, DeviceType } from '../device-type.js'
import type { VocabIcon } from './cap-vocabulary-icon.js'
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

/** A state a device is in whatever it is: unreachable, or silent. Identical for every look. */
const OFFLINE = look('wifi-off', 'muted', 'plain', 'none')
const UNKNOWN = look('circle-question-mark', 'muted', 'plain', 'none')
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
    unknown: UNKNOWN,
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

const LEAK_LOOK = lookOf({
  icon: 'droplets',
  on: ['danger', 'water', 'wave'],
  off: MUTED,
  running: ['danger', 'water', 'wave'],
  idle: INFO,
  standby: WARN,
  alert: look('droplets', 'danger', 'alert-wash', 'pulse'),
})

const SMOKE_LOOK = lookOf({
  icon: 'flame',
  on: ['danger', 'alert-wash', 'pulse'],
  off: MUTED,
  running: ['danger', 'alert-wash', 'pulse'],
  idle: INFO,
  standby: WARN,
  alert: look('flame', 'danger', 'alert-wash', 'pulse'),
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

/** The shield glows while armed, blinks red in alarm and goes quiet when disarmed. */
const ALARM_LOOK: HeroLook = {
  ...lookOf({
    icon: 'shield-check',
    on: ['success', 'glow', 'halo'],
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

export const HERO_LOOK_BY_TYPE = {
  [DeviceType.Camera]: HERO_LOOK_DEFAULT,
  [DeviceType.Hub]: HERO_LOOK_DEFAULT,
  [DeviceType.Light]: HERO_LOOK_DEFAULT,
  [DeviceType.Siren]: HERO_LOOK_DEFAULT,
  [DeviceType.Switch]: SWITCH_LOOK,
  [DeviceType.Sensor]: HERO_LOOK_DEFAULT,
  [DeviceType.Thermostat]: HERO_LOOK_DEFAULT,
  [DeviceType.Climate]: HERO_LOOK_DEFAULT,
  [DeviceType.Button]: HERO_LOOK_DEFAULT,
  [DeviceType.EventEmitter]: EVENT_EMITTER_LOOK,
  [DeviceType.Update]: HERO_LOOK_DEFAULT,
  [DeviceType.Generic]: HERO_LOOK_DEFAULT,
  [DeviceType.Notifier]: HERO_LOOK_DEFAULT,
  [DeviceType.Script]: SCRIPT_LOOK,
  [DeviceType.Automation]: AUTOMATION_LOOK,
  [DeviceType.Lock]: LOCK_LOOK,
  [DeviceType.Cover]: HERO_LOOK_DEFAULT,
  [DeviceType.Valve]: HERO_LOOK_DEFAULT,
  [DeviceType.Humidifier]: HERO_LOOK_DEFAULT,
  [DeviceType.WaterHeater]: HERO_LOOK_DEFAULT,
  [DeviceType.Fan]: FAN_LOOK,
  [DeviceType.MediaPlayer]: MEDIA_PLAYER_LOOK,
  [DeviceType.AlarmPanel]: ALARM_LOOK,
  [DeviceType.Control]: HERO_LOOK_DEFAULT,
  [DeviceType.Presence]: HERO_LOOK_DEFAULT,
  [DeviceType.Weather]: HERO_LOOK_DEFAULT,
  [DeviceType.Vacuum]: VACUUM_LOOK,
  [DeviceType.LawnMower]: MOWER_LOOK,
  [DeviceType.Container]: HERO_LOOK_DEFAULT,
  [DeviceType.Image]: HERO_LOOK_DEFAULT,
  [DeviceType.PetFeeder]: FEEDER_LOOK,
  [DeviceType.PetFountain]: FOUNTAIN_LOOK,
  [DeviceType.Dishwasher]: DISHWASHER_LOOK,
  [DeviceType.Washer]: WASHER_LOOK,
  [DeviceType.Heater]: HEATER_LOOK,
  [DeviceType.Dryer]: DRYER_LOOK,
  [DeviceType.Gateway]: HERO_LOOK_DEFAULT,
} as const satisfies Record<DeviceType, HeroLook>

/** `inherit` = take the type's look. A role only REFINES a type; it never replaces the type system. */
export const HERO_LOOK_BY_ROLE = {
  [DeviceRole.Siren]: 'inherit',
  [DeviceRole.Floodlight]: 'inherit',
  [DeviceRole.Spotlight]: 'inherit',
  [DeviceRole.PirSensor]: 'inherit',
  [DeviceRole.Chime]: 'inherit',
  [DeviceRole.Autotrack]: 'inherit',
  [DeviceRole.Nightvision]: 'inherit',
  [DeviceRole.PrivacyMask]: 'inherit',
  [DeviceRole.Doorbell]: 'inherit',
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
  [DeviceRole.MotionSensor]: 'inherit',
  [DeviceRole.ContactSensor]: 'inherit',
  [DeviceRole.LeakSensor]: LEAK_LOOK,
  [DeviceRole.SmokeSensor]: SMOKE_LOOK,
  [DeviceRole.COSensor]: 'inherit',
  [DeviceRole.GasSensor]: 'inherit',
  [DeviceRole.TamperSensor]: 'inherit',
  [DeviceRole.VibrationSensor]: 'inherit',
  [DeviceRole.ConnectivitySensor]: 'inherit',
  [DeviceRole.SoundSensor]: 'inherit',
  [DeviceRole.BinarySensor]: 'inherit',
  [DeviceRole.TemperatureSensor]: 'inherit',
  [DeviceRole.HumiditySensor]: 'inherit',
  [DeviceRole.AmbientLightSensor]: 'inherit',
  [DeviceRole.PressureSensor]: 'inherit',
  [DeviceRole.WindSensor]: 'inherit',
  [DeviceRole.RainSensor]: 'inherit',
  [DeviceRole.UvSensor]: 'inherit',
  [DeviceRole.SolarRadiationSensor]: 'inherit',
  [DeviceRole.SoilMoistureSensor]: 'inherit',
  [DeviceRole.PowerSensor]: 'inherit',
  [DeviceRole.EnergySensor]: 'inherit',
  [DeviceRole.VoltageSensor]: 'inherit',
  [DeviceRole.CurrentSensor]: 'inherit',
  [DeviceRole.AirQualitySensor]: 'inherit',
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

/** The look of a (role, type) pair, for a state. Role beats type beats the generic default. */
export function resolveHeroLook(role: string | null, type: string, state: HeroState): StateLook {
  const byRole = role !== null && isDeviceRole(role) ? HERO_LOOK_BY_ROLE[role] : undefined
  if (byRole !== undefined && byRole !== 'inherit') return byRole[state]
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
