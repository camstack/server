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
  'ac-airflow',
  'heater-rise',
  'drum',
  'dishwasher-spray',
  'fountain',
  'feeder-auger',
  'roamer',
  'tv-eq',
  'speaker-rings',
  'camera-live',
  'light-rays',
  'cover-slats',
  'lock',
  'alarm-shield',
  'siren-beam',
  'temperature-sparkline',
  'contact-door',
  'presence-radar',
  'weather',
  'plug-current',
  'button',
  'update-arrow',
  'control-dial',
  'event-stream',
  'gateway-hub',
  'generic-terminal',
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
  [DeviceType.Camera]: 'camera-live',
  [DeviceType.Hub]: 'gateway-hub',
  [DeviceType.Light]: 'light-rays',
  [DeviceType.Siren]: 'siren-beam',
  [DeviceType.Switch]: 'plug-current',
  [DeviceType.Sensor]: 'temperature-sparkline',
  [DeviceType.Thermostat]: 'ac-airflow',
  [DeviceType.Climate]: 'ac-airflow',
  [DeviceType.Button]: 'button',
  [DeviceType.EventEmitter]: 'event-stream',
  [DeviceType.Update]: 'update-arrow',
  [DeviceType.Generic]: 'generic-terminal',
  [DeviceType.Notifier]: 'event-stream',
  [DeviceType.Script]: 'event-stream',
  [DeviceType.Automation]: 'event-stream',
  [DeviceType.Lock]: 'lock',
  [DeviceType.Cover]: 'cover-slats',
  [DeviceType.Valve]: 'control-dial',
  [DeviceType.Humidifier]: 'control-dial',
  [DeviceType.WaterHeater]: 'heater-rise',
  [DeviceType.Fan]: 'ac-airflow',
  [DeviceType.MediaPlayer]: 'tv-eq',
  [DeviceType.AlarmPanel]: 'alarm-shield',
  [DeviceType.Control]: 'control-dial',
  [DeviceType.Presence]: 'presence-radar',
  [DeviceType.Weather]: 'weather',
  [DeviceType.Vacuum]: 'roamer',
  [DeviceType.LawnMower]: 'roamer',
  [DeviceType.Container]: 'generic-terminal',
  [DeviceType.Image]: 'camera-live',
  [DeviceType.PetFeeder]: 'feeder-auger',
  [DeviceType.PetFountain]: 'fountain',
  [DeviceType.Dishwasher]: 'dishwasher-spray',
  [DeviceType.Washer]: 'drum',
  [DeviceType.Heater]: 'heater-rise',
  [DeviceType.Dryer]: 'drum',
  [DeviceType.Gateway]: 'gateway-hub',
} as const satisfies Record<DeviceType, HeroSceneId>

/** `inherit` = the type's scene. A role only refines a type. */
export const HERO_SCENE_BY_ROLE = {
  [DeviceRole.Siren]: 'siren-beam',
  [DeviceRole.Floodlight]: 'light-rays',
  [DeviceRole.Spotlight]: 'light-rays',
  [DeviceRole.PirSensor]: 'presence-radar',
  [DeviceRole.Chime]: 'speaker-rings',
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
  [DeviceRole.Outlet]: 'plug-current',
  [DeviceRole.MotionSensor]: 'presence-radar',
  [DeviceRole.ContactSensor]: 'contact-door',
  [DeviceRole.LeakSensor]: 'inherit',
  [DeviceRole.SmokeSensor]: 'alarm-shield',
  [DeviceRole.COSensor]: 'alarm-shield',
  [DeviceRole.GasSensor]: 'alarm-shield',
  [DeviceRole.TamperSensor]: 'inherit',
  [DeviceRole.VibrationSensor]: 'inherit',
  [DeviceRole.ConnectivitySensor]: 'inherit',
  [DeviceRole.SoundSensor]: 'inherit',
  [DeviceRole.BinarySensor]: 'inherit',
  [DeviceRole.TemperatureSensor]: 'temperature-sparkline',
  [DeviceRole.HumiditySensor]: 'temperature-sparkline',
  [DeviceRole.AmbientLightSensor]: 'inherit',
  [DeviceRole.PressureSensor]: 'weather',
  [DeviceRole.WindSensor]: 'weather',
  [DeviceRole.RainSensor]: 'weather',
  [DeviceRole.UvSensor]: 'weather',
  [DeviceRole.SolarRadiationSensor]: 'weather',
  [DeviceRole.SoilMoistureSensor]: 'inherit',
  [DeviceRole.PowerSensor]: 'plug-current',
  [DeviceRole.EnergySensor]: 'plug-current',
  [DeviceRole.VoltageSensor]: 'plug-current',
  [DeviceRole.CurrentSensor]: 'plug-current',
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
  return isDeviceType(type) ? HERO_SCENE_BY_TYPE[type] : 'generic-terminal'
}
