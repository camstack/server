/**
 * The SCENE of a device (D1023 P2): which animated picture its hero and its
 * list row draw. One declaration per {@link DeviceType} (refined by a
 * {@link DeviceRole}), served by the same model to the hero (large) and to the
 * row (a 44x44 mini-scene): the two are the same id at two sizes.
 *
 * A scene only names WHAT is drawn. HOW it moves is not restated here: the
 * motion and backdrop are the state look's `animation` / `background` tokens
 * (`hero-look.ts`), and a scene's variable part is the closed {@link SceneMode}
 * plus a `level` in 0..1 (volume, position, progress). Nothing else varies.
 *
 * Exhaustive like the looks: `satisfies Record<…>` over the enums, re-checked at
 * runtime by `scripts/check-hero-look-exhaustive.ts`.
 */
import { z } from 'zod'
import { DeviceRole, DeviceType } from '../device-type.js'

export const HERO_SCENES = [
  'ac',
  'thermostat',
  'heater',
  'heat-pump',
  'fan',
  'washer',
  'dryer',
  'dishwasher',
  'pet-fountain',
  'pet-feeder',
  'vacuum',
  'lawn-mower',
  'tv',
  'speaker',
  'camera',
  'light',
  'cover',
  'lock',
  'alarm',
  'siren',
  'sensor-sparkline',
  'contact',
  'presence',
  'weather',
  'plug',
  'button',
  'update',
  'control-dial',
  'event-stream',
  'gateway',
  'generic',
] as const
export type HeroSceneId = (typeof HERO_SCENES)[number]
export const HeroSceneIdSchema = z.enum(HERO_SCENES)

/** What a scene is doing, when the device says: an air conditioner's mode, a player's transport, a door's side. */
export const HERO_SCENE_MODES = [
  'cool',
  'heat',
  'dry',
  'fan',
  'auto',
  'playing',
  'paused',
  'open',
  'closed',
] as const
export type HeroSceneMode = (typeof HERO_SCENE_MODES)[number]
export const HeroSceneModeSchema = z.enum(HERO_SCENE_MODES)

/** The scene as the model carries it. `null` = the device did not say (never a guess). */
export const HeroSceneSchema = z.object({
  id: HeroSceneIdSchema,
  mode: HeroSceneModeSchema.nullable(),
  /** 0..1: volume, cover position, cycle progress. */
  level: z.number().min(0).max(1).nullable(),
})
export type HeroScene = z.infer<typeof HeroSceneSchema>

export const HERO_SCENE_BY_TYPE = {
  [DeviceType.Camera]: 'camera',
  [DeviceType.Hub]: 'gateway',
  [DeviceType.Light]: 'light',
  [DeviceType.Siren]: 'siren',
  [DeviceType.Switch]: 'plug',
  [DeviceType.Sensor]: 'sensor-sparkline',
  [DeviceType.Thermostat]: 'thermostat',
  [DeviceType.Climate]: 'ac',
  [DeviceType.Button]: 'button',
  [DeviceType.EventEmitter]: 'event-stream',
  [DeviceType.Update]: 'update',
  [DeviceType.Generic]: 'generic',
  [DeviceType.Notifier]: 'event-stream',
  [DeviceType.Script]: 'event-stream',
  [DeviceType.Automation]: 'event-stream',
  [DeviceType.Lock]: 'lock',
  [DeviceType.Cover]: 'cover',
  [DeviceType.Valve]: 'control-dial',
  [DeviceType.Humidifier]: 'control-dial',
  [DeviceType.WaterHeater]: 'heater',
  [DeviceType.HeatPump]: 'heat-pump',
  [DeviceType.Fan]: 'fan',
  [DeviceType.MediaPlayer]: 'tv',
  [DeviceType.AlarmPanel]: 'alarm',
  [DeviceType.Control]: 'control-dial',
  [DeviceType.Presence]: 'presence',
  [DeviceType.Weather]: 'weather',
  [DeviceType.Vacuum]: 'vacuum',
  [DeviceType.LawnMower]: 'lawn-mower',
  [DeviceType.Container]: 'generic',
  [DeviceType.Image]: 'camera',
  [DeviceType.PetFeeder]: 'pet-feeder',
  [DeviceType.PetFountain]: 'pet-fountain',
  [DeviceType.Dishwasher]: 'dishwasher',
  [DeviceType.Washer]: 'washer',
  [DeviceType.Heater]: 'heater',
  [DeviceType.Dryer]: 'dryer',
  [DeviceType.Gateway]: 'gateway',
} as const satisfies Record<DeviceType, HeroSceneId>

/** `inherit` = the type's scene. A role only refines a type. */
export const HERO_SCENE_BY_ROLE = {
  [DeviceRole.Siren]: 'siren',
  [DeviceRole.Floodlight]: 'light',
  [DeviceRole.Spotlight]: 'light',
  [DeviceRole.PirSensor]: 'presence',
  [DeviceRole.Chime]: 'speaker',
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
  [DeviceRole.Outlet]: 'plug',
  [DeviceRole.MotionSensor]: 'presence',
  [DeviceRole.ContactSensor]: 'contact',
  [DeviceRole.LeakSensor]: 'inherit',
  [DeviceRole.SmokeSensor]: 'alarm',
  [DeviceRole.COSensor]: 'alarm',
  [DeviceRole.GasSensor]: 'alarm',
  [DeviceRole.TamperSensor]: 'inherit',
  [DeviceRole.VibrationSensor]: 'inherit',
  [DeviceRole.ConnectivitySensor]: 'inherit',
  [DeviceRole.SoundSensor]: 'inherit',
  [DeviceRole.BinarySensor]: 'inherit',
  [DeviceRole.TemperatureSensor]: 'sensor-sparkline',
  [DeviceRole.HumiditySensor]: 'sensor-sparkline',
  [DeviceRole.AmbientLightSensor]: 'inherit',
  [DeviceRole.PressureSensor]: 'weather',
  [DeviceRole.WindSensor]: 'weather',
  [DeviceRole.RainSensor]: 'weather',
  [DeviceRole.UvSensor]: 'weather',
  [DeviceRole.SolarRadiationSensor]: 'weather',
  [DeviceRole.SoilMoistureSensor]: 'inherit',
  [DeviceRole.PowerSensor]: 'plug',
  [DeviceRole.EnergySensor]: 'plug',
  [DeviceRole.VoltageSensor]: 'plug',
  [DeviceRole.CurrentSensor]: 'plug',
  [DeviceRole.AirQualitySensor]: 'inherit',
  [DeviceRole.BatterySensor]: 'inherit',
  [DeviceRole.NumericSensor]: 'inherit',
  [DeviceRole.EnumSensor]: 'inherit',
  [DeviceRole.DateTimeSensor]: 'inherit',
  [DeviceRole.GenericSensor]: 'inherit',
  [DeviceRole.NumericControl]: 'control-dial',
  [DeviceRole.SelectControl]: 'control-dial',
  [DeviceRole.TextControl]: 'inherit',
  [DeviceRole.DateTimeControl]: 'inherit',
  [DeviceRole.MobilePushNotifier]: 'inherit',
  [DeviceRole.MessagingNotifier]: 'inherit',
  [DeviceRole.EmailNotifier]: 'inherit',
  [DeviceRole.GenericNotifier]: 'inherit',
  [DeviceRole.IrTransmitter]: 'inherit',
} as const satisfies Record<DeviceRole, HeroSceneId | 'inherit'>

function isDeviceType(type: string): type is DeviceType {
  return Object.values<string>(DeviceType).includes(type)
}

function isDeviceRole(role: string): role is DeviceRole {
  return Object.values<string>(DeviceRole).includes(role)
}

/** The scene id of a (role, type) pair. Role beats type; a type this build does not know gets the terminal. */
export function resolveHeroSceneId(role: string | null, type: string): HeroSceneId {
  const byRole = role !== null && isDeviceRole(role) ? HERO_SCENE_BY_ROLE[role] : undefined
  if (byRole !== undefined && byRole !== 'inherit') return byRole
  return isDeviceType(type) ? HERO_SCENE_BY_TYPE[type] : 'generic'
}
