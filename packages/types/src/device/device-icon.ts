/**
 * device-icon — THE icon of a device, from what it IS: its {@link DeviceType},
 * refined by its {@link DeviceRole}. One table for every surface: the admin's
 * rows, cards, page header, lists and pickers draw it through ui-library's
 * glyph table, the viewer through its catalog nodes. The value is a key of the
 * icon catalog (D854), never a glyph.
 *
 * Exhaustive over both enums (`satisfies Record<…>`): a new type or role fails
 * the build until it has an icon. Nothing here reads a name, a provider or a
 * capability — an icon picked from those would be invented.
 *
 * Precedence: a known role → its icon; otherwise the type's icon; a type this
 * build does not know → the generic type's icon. An operator's per-device or
 * per-role display override is the caller's level above this one.
 */
import { DeviceRole, DeviceType } from './device-type.js'
import type { IconKey } from './icon-catalog.js'

/** The icon of each device type. */
export const DEVICE_TYPE_ICON = {
  [DeviceType.Camera]: 'camera',
  [DeviceType.Light]: 'lightbulb',
  [DeviceType.Siren]: 'siren',
  [DeviceType.Switch]: 'toggle-left',
  [DeviceType.Sensor]: 'activity',
  [DeviceType.Climate]: 'thermometer',
  [DeviceType.HeatPump]: 'flame',
  [DeviceType.EnergySystem]: 'solar-panel',
  [DeviceType.Button]: 'circle-dot',
  [DeviceType.EventEmitter]: 'zap',
  [DeviceType.Update]: 'refresh-cw',
  [DeviceType.Generic]: 'box',
  [DeviceType.Notifier]: 'bell',
  [DeviceType.Script]: 'scroll-text',
  [DeviceType.Automation]: 'workflow',
  [DeviceType.Lock]: 'lock',
  [DeviceType.Cover]: 'blinds',
  [DeviceType.Valve]: 'pipette',
  [DeviceType.Humidifier]: 'waves',
  [DeviceType.WaterHeater]: 'bath',
  [DeviceType.Fan]: 'fan',
  [DeviceType.MediaPlayer]: 'monitor-play',
  [DeviceType.AlarmPanel]: 'shield-alert',
  [DeviceType.Control]: 'sliders-horizontal',
  [DeviceType.Presence]: 'map-pin',
  [DeviceType.Weather]: 'cloud-sun',
  [DeviceType.Vacuum]: 'bot',
  [DeviceType.LawnMower]: 'tractor',
  [DeviceType.Container]: 'box',
  [DeviceType.Image]: 'image',
  [DeviceType.PetFeeder]: 'bone',
  [DeviceType.PetFountain]: 'droplets',
  [DeviceType.Dishwasher]: 'waves',
  [DeviceType.Washer]: 'washing-machine',
  [DeviceType.Dryer]: 'wind',
  [DeviceType.Gateway]: 'router',
} as const satisfies Record<DeviceType, IconKey>

/** The icon of each role: what the device is FOR, which reads better than its type. */
export const DEVICE_ROLE_ICON = {
  [DeviceRole.Siren]: 'siren',
  [DeviceRole.Floodlight]: 'lightbulb',
  [DeviceRole.Spotlight]: 'flashlight',
  [DeviceRole.PirSensor]: 'radar',
  [DeviceRole.Chime]: 'bell',
  [DeviceRole.Autotrack]: 'crosshair',
  [DeviceRole.Nightvision]: 'moon',
  [DeviceRole.PrivacyMask]: 'eye-off',
  [DeviceRole.Doorbell]: 'door-closed',
  [DeviceRole.CoverBlind]: 'blinds',
  [DeviceRole.CoverShutter]: 'blinds',
  [DeviceRole.CoverAwning]: 'blinds',
  [DeviceRole.CoverCurtain]: 'blinds',
  [DeviceRole.CoverGarage]: 'door-closed',
  [DeviceRole.CoverGate]: 'door-closed',
  [DeviceRole.CoverDoor]: 'door-open',
  [DeviceRole.CoverWindow]: 'blinds',
  [DeviceRole.BinaryHelper]: 'toggle-left',
  [DeviceRole.Outlet]: 'plug',
  [DeviceRole.SwitchHeater]: 'flame',
  [DeviceRole.SwitchFan]: 'fan',
  [DeviceRole.SwitchLight]: 'lightbulb',
  [DeviceRole.ClimateAc]: 'air-vent',
  [DeviceRole.ClimateThermostat]: 'thermometer',
  [DeviceRole.ClimateFloor]: 'waves',
  [DeviceRole.ClimateRadiator]: 'heater',
  [DeviceRole.ClimateHeater]: 'flame',
  [DeviceRole.ClimateHeatPumpCircuit]: 'refresh-cw',
  [DeviceRole.MotionSensor]: 'footprints',
  [DeviceRole.ContactSensor]: 'door-open',
  [DeviceRole.LeakSensor]: 'droplet',
  [DeviceRole.SmokeSensor]: 'alarm-smoke',
  [DeviceRole.COSensor]: 'wind',
  [DeviceRole.GasSensor]: 'flame',
  [DeviceRole.TamperSensor]: 'shield-alert',
  [DeviceRole.VibrationSensor]: 'vibrate',
  [DeviceRole.ConnectivitySensor]: 'wifi',
  [DeviceRole.SoundSensor]: 'volume-2',
  [DeviceRole.BinarySensor]: 'toggle-left',
  [DeviceRole.TemperatureSensor]: 'thermometer',
  [DeviceRole.HumiditySensor]: 'droplets',
  [DeviceRole.AmbientLightSensor]: 'sun',
  [DeviceRole.PressureSensor]: 'gauge',
  [DeviceRole.WindSensor]: 'wind',
  [DeviceRole.RainSensor]: 'cloud-rain',
  [DeviceRole.UvSensor]: 'sun-medium',
  [DeviceRole.SolarRadiationSensor]: 'sunrise',
  [DeviceRole.SoilMoistureSensor]: 'sprout',
  [DeviceRole.PowerSensor]: 'zap',
  [DeviceRole.EnergySensor]: 'zap',
  [DeviceRole.VoltageSensor]: 'zap',
  [DeviceRole.CurrentSensor]: 'zap',
  [DeviceRole.AirQualitySensor]: 'wind',
  [DeviceRole.BatterySensor]: 'gauge',
  [DeviceRole.NumericSensor]: 'hash',
  [DeviceRole.EnumSensor]: 'list',
  [DeviceRole.DateTimeSensor]: 'clock',
  [DeviceRole.GenericSensor]: 'gauge',
  [DeviceRole.NumericControl]: 'sliders-horizontal',
  [DeviceRole.SelectControl]: 'list-checks',
  [DeviceRole.TextControl]: 'type',
  [DeviceRole.DateTimeControl]: 'clock',
  [DeviceRole.MobilePushNotifier]: 'smartphone',
  [DeviceRole.MessagingNotifier]: 'message-square',
  [DeviceRole.EmailNotifier]: 'mail',
  [DeviceRole.GenericNotifier]: 'bell',
  [DeviceRole.IrTransmitter]: 'radio-tower',
} as const satisfies Record<DeviceRole, IconKey>

/** Every icon a device can be drawn with — a subset of the catalog the glyph tables must cover. */
export type DeviceIconKey =
  | (typeof DEVICE_TYPE_ICON)[DeviceType]
  | (typeof DEVICE_ROLE_ICON)[DeviceRole]

const TYPE_VALUES: ReadonlySet<string> = new Set<string>(Object.values(DeviceType))
const ROLE_VALUES: ReadonlySet<string> = new Set<string>(Object.values(DeviceRole))

function isDeviceType(value: string): value is DeviceType {
  return TYPE_VALUES.has(value)
}

function isDeviceRole(value: string): value is DeviceRole {
  return ROLE_VALUES.has(value)
}

/** The icon of a device type alone; a type this build does not know draws the generic one. */
export function deviceTypeIconKey(type: string): DeviceIconKey {
  return isDeviceType(type) ? DEVICE_TYPE_ICON[type] : DEVICE_TYPE_ICON[DeviceType.Generic]
}

/** The icon of a role alone, or `null` for a role this build does not know. */
export function deviceRoleIconKey(role: string): DeviceIconKey | null {
  return isDeviceRole(role) ? DEVICE_ROLE_ICON[role] : null
}

/**
 * The icon of a device: its role's when the role is known, else its type's.
 * An unknown role never borrows another role's icon — it is drawn as its type.
 */
export function deviceIconKey(type: string, role?: string | null): DeviceIconKey {
  const byRole = role === null || role === undefined ? null : deviceRoleIconKey(role)
  return byRole ?? deviceTypeIconKey(type)
}
