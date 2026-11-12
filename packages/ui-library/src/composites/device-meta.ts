import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  AirVent,
  AlarmSmoke,
  Bath,
  Battery,
  Bell,
  Blinds,
  Bone,
  Bot,
  Box,
  Camera,
  CircleDot,
  Clock,
  CloudRain,
  CloudSun,
  Crosshair,
  DoorClosed,
  DoorOpen,
  Droplet,
  Droplets,
  EyeOff,
  Fan,
  Flame,
  Flashlight,
  Footprints,
  Gauge,
  Heater,
  Hash,
  Image,
  Lightbulb,
  List,
  ListChecks,
  Lock,
  Mail,
  MapPin,
  MessageSquare,
  MonitorPlay,
  Moon,
  Network,
  Pipette,
  Plug,
  Power,
  Radar,
  Router,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Siren,
  SlidersHorizontal,
  Smartphone,
  Sprout,
  Sun,
  SunMedium,
  Sunrise,
  Thermometer,
  ToggleLeft,
  Tractor,
  Type,
  Vibrate,
  Volume2,
  WashingMachine,
  Waves,
  RadioTower,
  Wifi,
  Wind,
  Workflow,
  Zap,
} from 'lucide-react'
import {
  DEVICE_ROLE_ICON,
  DEVICE_TYPE_ICON,
  DeviceRole,
  DeviceType,
  deviceIconKey,
  type DeviceIconKey,
  type IconKey,
} from '@camstack/types'
import type { MultiSelectOption } from './device-list/multi-select'
import { defaultUiText, type UiTextFn } from '../contexts/ui-text'

/**
 * How the admin renders a device TYPE or ROLE: its icon + label.
 *
 * The ICON is not chosen here: it is `DEVICE_TYPE_ICON` / `DEVICE_ROLE_ICON`
 * from `@camstack/types` (the one resolver the viewer uses too), drawn through
 * `FAST_ICON_GLYPHS`. The LABEL tables are `Record<DeviceType | DeviceRole, …>`,
 * so a new enum member fails the build until it has a label here and an icon
 * there.
 *
 * Lives in `@camstack/ui-library` because the glyphs are `lucide-react`
 * components; the labels are the user-facing defaults (wire i18n at the call
 * site if a translation is needed).
 */
export interface DeviceTypeMeta {
  readonly icon: LucideIcon
  readonly label: string
}
export interface DeviceRoleMeta {
  readonly icon: LucideIcon
  readonly label: string
}

/** A label: a catalogue key + English fallback, resolved by the consumer. */
export interface DeviceMetaLabel {
  readonly labelKey: string
  readonly labelFallback: string
}

/** A table row: the shared resolver's glyph plus the label. */
export interface DeviceMetaEntry extends DeviceMetaLabel {
  readonly icon: LucideIcon
}

function resolveMeta(entry: DeviceMetaEntry, t: UiTextFn): DeviceTypeMeta {
  return { icon: entry.icon, label: t(entry.labelKey, entry.labelFallback) }
}

/**
 * The glyphs the admin draws on FIRST PAINT, synchronously — every icon the
 * shared device resolver (`DEVICE_TYPE_ICON` / `DEVICE_ROLE_ICON` in
 * `@camstack/types`) can return, which the type makes exhaustive. Everything else in
 * the icon catalog is drawn from the lazily loaded full table
 * (`icon-glyphs.ts`), so the initial chunk carries ~60 lucide icons instead of
 * one static import per catalog key (D854).
 *
 * Typed `Partial<Record<IconKey, ...>>`: a key that is not in the catalog is a
 * compile error, so this table can never become a second vocabulary — it is a
 * cache of glyphs, not a list of choices.
 */
export const FAST_ICON_GLYPHS: Readonly<
  Record<DeviceIconKey, LucideIcon> & Partial<Record<IconKey, LucideIcon>>
> = {
  camera: Camera,
  network: Network,
  'toggle-left': ToggleLeft,
  'circle-dot': CircleDot,
  'refresh-cw': RefreshCw,
  box: Box,
  'scroll-text': ScrollText,
  workflow: Workflow,
  lock: Lock,
  blinds: Blinds,
  'air-vent': AirVent,
  'monitor-play': MonitorPlay,
  'sliders-horizontal': SlidersHorizontal,
  'map-pin': MapPin,
  bot: Bot,
  tractor: Tractor,
  image: Image,
  bone: Bone,
  'door-closed': DoorClosed,
  'door-open': DoorOpen,
  crosshair: Crosshair,
  'eye-off': EyeOff,
  smartphone: Smartphone,
  power: Power,
  battery: Battery,
  lightbulb: Lightbulb,
  flashlight: Flashlight,
  thermometer: Thermometer,
  droplets: Droplets,
  droplet: Droplet,
  gauge: Gauge,
  sun: Sun,
  'sun-medium': SunMedium,
  sunrise: Sunrise,
  moon: Moon,
  wind: Wind,
  'cloud-rain': CloudRain,
  'cloud-sun': CloudSun,
  waves: Waves,
  sprout: Sprout,
  zap: Zap,
  flame: Flame,
  bell: Bell,
  siren: Siren,
  radar: Radar,
  activity: Activity,
  hash: Hash,
  clock: Clock,
  pipette: Pipette,
  fan: Fan,
  bath: Bath,
  footprints: Footprints,
  'alarm-smoke': AlarmSmoke,
  'shield-alert': ShieldAlert,
  vibrate: Vibrate,
  wifi: Wifi,
  'volume-2': Volume2,
  list: List,
  'list-checks': ListChecks,
  mail: Mail,
  'message-square': MessageSquare,
  type: Type,
  'washing-machine': WashingMachine,
  router: Router,
  plug: Plug,
  heater: Heater,
  'radio-tower': RadioTower,
}

/** The glyph of a device: its role's icon when the role is known, else its type's (`deviceIconKey`). */
export function deviceIconGlyph(type: string, role?: string | null): LucideIcon {
  return FAST_ICON_GLYPHS[deviceIconKey(type, role)]
}

const DEVICE_TYPE_LABELS: Record<DeviceType, DeviceMetaLabel> = {
  [DeviceType.Camera]: {
    labelKey: 'uiLibrary.deviceMeta.type.camera',
    labelFallback: 'Camera',
  },
  [DeviceType.Hub]: {
    labelKey: 'uiLibrary.deviceMeta.type.hub',
    labelFallback: 'Hub',
  },
  [DeviceType.Light]: {
    labelKey: 'uiLibrary.deviceMeta.type.light',
    labelFallback: 'Light',
  },
  [DeviceType.Siren]: {
    labelKey: 'uiLibrary.deviceMeta.type.siren',
    labelFallback: 'Siren',
  },
  [DeviceType.Switch]: {
    labelKey: 'uiLibrary.deviceMeta.type.switch',
    labelFallback: 'Switch',
  },
  [DeviceType.Sensor]: {
    labelKey: 'uiLibrary.deviceMeta.type.sensor',
    labelFallback: 'Sensor',
  },
  [DeviceType.Climate]: {
    labelKey: 'uiLibrary.deviceMeta.type.climate',
    labelFallback: 'Climate',
  },
  [DeviceType.HeatPump]: {
    labelKey: 'uiLibrary.deviceMeta.type.heatPump',
    labelFallback: 'Heat pump',
  },
  [DeviceType.Button]: {
    labelKey: 'uiLibrary.deviceMeta.type.button',
    labelFallback: 'Button',
  },
  [DeviceType.EventEmitter]: {
    labelKey: 'uiLibrary.deviceMeta.type.eventEmitter',
    labelFallback: 'Event Emitter',
  },
  [DeviceType.Update]: {
    labelKey: 'uiLibrary.deviceMeta.type.update',
    labelFallback: 'Update',
  },
  [DeviceType.Generic]: {
    labelKey: 'uiLibrary.deviceMeta.type.generic',
    labelFallback: 'Generic',
  },
  [DeviceType.Notifier]: {
    labelKey: 'uiLibrary.deviceMeta.type.notifier',
    labelFallback: 'Notifier',
  },
  [DeviceType.Script]: {
    labelKey: 'uiLibrary.deviceMeta.type.script',
    labelFallback: 'Script',
  },
  [DeviceType.Automation]: {
    labelKey: 'uiLibrary.deviceMeta.type.automation',
    labelFallback: 'Automation',
  },
  [DeviceType.Lock]: {
    labelKey: 'uiLibrary.deviceMeta.type.lock',
    labelFallback: 'Lock',
  },
  [DeviceType.Cover]: {
    labelKey: 'uiLibrary.deviceMeta.type.cover',
    labelFallback: 'Cover',
  },
  [DeviceType.Valve]: {
    labelKey: 'uiLibrary.deviceMeta.type.valve',
    labelFallback: 'Valve',
  },
  [DeviceType.Humidifier]: {
    labelKey: 'uiLibrary.deviceMeta.type.humidifier',
    labelFallback: 'Humidifier',
  },
  [DeviceType.WaterHeater]: {
    labelKey: 'uiLibrary.deviceMeta.type.waterHeater',
    labelFallback: 'Water heater',
  },
  [DeviceType.Fan]: { labelKey: 'uiLibrary.deviceMeta.type.fan', labelFallback: 'Fan' },
  [DeviceType.MediaPlayer]: {
    labelKey: 'uiLibrary.deviceMeta.type.mediaPlayer',
    labelFallback: 'Media player',
  },
  [DeviceType.AlarmPanel]: {
    labelKey: 'uiLibrary.deviceMeta.type.alarmPanel',
    labelFallback: 'Alarm panel',
  },
  [DeviceType.Control]: {
    labelKey: 'uiLibrary.deviceMeta.type.control',
    labelFallback: 'Control',
  },
  [DeviceType.Presence]: {
    labelKey: 'uiLibrary.deviceMeta.type.presence',
    labelFallback: 'Presence',
  },
  [DeviceType.Weather]: {
    labelKey: 'uiLibrary.deviceMeta.type.weather',
    labelFallback: 'Weather',
  },
  [DeviceType.Vacuum]: {
    labelKey: 'uiLibrary.deviceMeta.type.vacuum',
    labelFallback: 'Vacuum',
  },
  [DeviceType.LawnMower]: {
    labelKey: 'uiLibrary.deviceMeta.type.lawnMower',
    labelFallback: 'Lawn mower',
  },
  [DeviceType.Container]: {
    labelKey: 'uiLibrary.deviceMeta.type.container',
    labelFallback: 'Container',
  },
  [DeviceType.Image]: {
    labelKey: 'uiLibrary.deviceMeta.type.image',
    labelFallback: 'Image',
  },
  [DeviceType.PetFeeder]: {
    labelKey: 'uiLibrary.deviceMeta.type.petFeeder',
    labelFallback: 'Pet feeder',
  },
  [DeviceType.PetFountain]: {
    labelKey: 'uiLibrary.deviceMeta.type.petFountain',
    labelFallback: 'Pet fountain',
  },
  [DeviceType.Dishwasher]: {
    labelKey: 'uiLibrary.deviceMeta.type.dishwasher',
    labelFallback: 'Dishwasher',
  },
  [DeviceType.Washer]: {
    labelKey: 'uiLibrary.deviceMeta.type.washer',
    labelFallback: 'Washing machine',
  },
  [DeviceType.Dryer]: {
    labelKey: 'uiLibrary.deviceMeta.type.dryer',
    labelFallback: 'Dryer',
  },
  [DeviceType.Gateway]: {
    labelKey: 'uiLibrary.deviceMeta.type.gateway',
    labelFallback: 'Gateway',
  },
}

const DEVICE_ROLE_LABELS: Record<DeviceRole, DeviceMetaLabel> = {
  [DeviceRole.Siren]: {
    labelKey: 'uiLibrary.deviceMeta.role.siren',
    labelFallback: 'Siren',
  },
  [DeviceRole.Floodlight]: {
    labelKey: 'uiLibrary.deviceMeta.role.floodlight',
    labelFallback: 'Floodlight',
  },
  [DeviceRole.Spotlight]: {
    labelKey: 'uiLibrary.deviceMeta.role.spotlight',
    labelFallback: 'Spotlight',
  },
  [DeviceRole.PirSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.pirSensor',
    labelFallback: 'PIR sensor',
  },
  [DeviceRole.Chime]: {
    labelKey: 'uiLibrary.deviceMeta.role.chime',
    labelFallback: 'Chime',
  },
  [DeviceRole.Autotrack]: {
    labelKey: 'uiLibrary.deviceMeta.role.autotrack',
    labelFallback: 'Auto-track',
  },
  [DeviceRole.Nightvision]: {
    labelKey: 'uiLibrary.deviceMeta.role.nightvision',
    labelFallback: 'Night vision',
  },
  [DeviceRole.PrivacyMask]: {
    labelKey: 'uiLibrary.deviceMeta.role.privacyMask',
    labelFallback: 'Privacy mask',
  },
  [DeviceRole.Doorbell]: {
    labelKey: 'uiLibrary.deviceMeta.role.doorbell',
    labelFallback: 'Doorbell',
  },
  [DeviceRole.CoverBlind]: {
    labelKey: 'uiLibrary.deviceMeta.role.coverBlind',
    labelFallback: 'Blind',
  },
  [DeviceRole.CoverShutter]: {
    labelKey: 'uiLibrary.deviceMeta.role.coverShutter',
    labelFallback: 'Shutter',
  },
  [DeviceRole.CoverAwning]: {
    labelKey: 'uiLibrary.deviceMeta.role.coverAwning',
    labelFallback: 'Awning',
  },
  [DeviceRole.CoverCurtain]: {
    labelKey: 'uiLibrary.deviceMeta.role.coverCurtain',
    labelFallback: 'Curtain',
  },
  [DeviceRole.CoverGarage]: {
    labelKey: 'uiLibrary.deviceMeta.role.coverGarage',
    labelFallback: 'Garage door',
  },
  [DeviceRole.CoverGate]: {
    labelKey: 'uiLibrary.deviceMeta.role.coverGate',
    labelFallback: 'Gate',
  },
  [DeviceRole.CoverDoor]: {
    labelKey: 'uiLibrary.deviceMeta.role.coverDoor',
    labelFallback: 'Door',
  },
  [DeviceRole.CoverWindow]: {
    labelKey: 'uiLibrary.deviceMeta.role.coverWindow',
    labelFallback: 'Window',
  },
  [DeviceRole.BinaryHelper]: {
    labelKey: 'uiLibrary.deviceMeta.role.binaryHelper',
    labelFallback: 'Binary helper',
  },
  [DeviceRole.Outlet]: {
    labelKey: 'uiLibrary.deviceMeta.role.outlet',
    labelFallback: 'Outlet',
  },
  [DeviceRole.SwitchHeater]: {
    labelKey: 'uiLibrary.deviceMeta.role.switchHeater',
    labelFallback: 'Heater',
  },
  [DeviceRole.SwitchFan]: {
    labelKey: 'uiLibrary.deviceMeta.role.switchFan',
    labelFallback: 'Fan',
  },
  [DeviceRole.SwitchLight]: {
    labelKey: 'uiLibrary.deviceMeta.role.switchLight',
    labelFallback: 'On/off light',
  },
  [DeviceRole.ClimateAc]: {
    labelKey: 'uiLibrary.deviceMeta.role.climateAc',
    labelFallback: 'Air conditioner',
  },
  [DeviceRole.ClimateThermostat]: {
    labelKey: 'uiLibrary.deviceMeta.role.climateThermostat',
    labelFallback: 'Thermostat',
  },
  [DeviceRole.ClimateFloor]: {
    labelKey: 'uiLibrary.deviceMeta.role.climateFloor',
    labelFallback: 'Floor heating',
  },
  [DeviceRole.ClimateRadiator]: {
    labelKey: 'uiLibrary.deviceMeta.role.climateRadiator',
    labelFallback: 'Radiator',
  },
  [DeviceRole.ClimateHeater]: {
    labelKey: 'uiLibrary.deviceMeta.role.climateHeater',
    labelFallback: 'Heater',
  },
  [DeviceRole.ClimateHeatPumpCircuit]: {
    labelKey: 'uiLibrary.deviceMeta.role.climateHeatPumpCircuit',
    labelFallback: 'Heat pump circuit',
  },
  [DeviceRole.MotionSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.motionSensor',
    labelFallback: 'Motion sensor',
  },
  [DeviceRole.ContactSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.contactSensor',
    labelFallback: 'Contact sensor',
  },
  [DeviceRole.LeakSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.leakSensor',
    labelFallback: 'Leak sensor',
  },
  [DeviceRole.SmokeSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.smokeSensor',
    labelFallback: 'Smoke sensor',
  },
  [DeviceRole.COSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.cOSensor',
    labelFallback: 'CO sensor',
  },
  [DeviceRole.GasSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.gasSensor',
    labelFallback: 'Gas sensor',
  },
  [DeviceRole.TamperSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.tamperSensor',
    labelFallback: 'Tamper sensor',
  },
  [DeviceRole.VibrationSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.vibrationSensor',
    labelFallback: 'Vibration sensor',
  },
  [DeviceRole.ConnectivitySensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.connectivitySensor',
    labelFallback: 'Connectivity',
  },
  [DeviceRole.SoundSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.soundSensor',
    labelFallback: 'Sound sensor',
  },
  [DeviceRole.BinarySensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.binarySensor',
    labelFallback: 'Binary sensor',
  },
  [DeviceRole.TemperatureSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.temperatureSensor',
    labelFallback: 'Temperature',
  },
  [DeviceRole.HumiditySensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.humiditySensor',
    labelFallback: 'Humidity',
  },
  [DeviceRole.AmbientLightSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.ambientLightSensor',
    labelFallback: 'Ambient light',
  },
  [DeviceRole.PressureSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.pressureSensor',
    labelFallback: 'Pressure',
  },
  [DeviceRole.WindSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.windSensor',
    labelFallback: 'Wind',
  },
  [DeviceRole.RainSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.rainSensor',
    labelFallback: 'Rain',
  },
  [DeviceRole.UvSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.uvSensor',
    labelFallback: 'UV index',
  },
  [DeviceRole.SolarRadiationSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.solarRadiationSensor',
    labelFallback: 'Solar radiation',
  },
  [DeviceRole.SoilMoistureSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.soilMoistureSensor',
    labelFallback: 'Soil moisture',
  },
  [DeviceRole.PowerSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.powerSensor',
    labelFallback: 'Power',
  },
  [DeviceRole.EnergySensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.energySensor',
    labelFallback: 'Energy',
  },
  [DeviceRole.VoltageSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.voltageSensor',
    labelFallback: 'Voltage',
  },
  [DeviceRole.CurrentSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.currentSensor',
    labelFallback: 'Current',
  },
  [DeviceRole.AirQualitySensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.airQualitySensor',
    labelFallback: 'Air quality',
  },
  [DeviceRole.BatterySensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.batterySensor',
    labelFallback: 'Battery',
  },
  [DeviceRole.NumericSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.numericSensor',
    labelFallback: 'Numeric sensor',
  },
  [DeviceRole.EnumSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.enumSensor',
    labelFallback: 'Enum sensor',
  },
  [DeviceRole.DateTimeSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.dateTimeSensor',
    labelFallback: 'Date / time',
  },
  [DeviceRole.GenericSensor]: {
    labelKey: 'uiLibrary.deviceMeta.role.genericSensor',
    labelFallback: 'Sensor',
  },
  [DeviceRole.NumericControl]: {
    labelKey: 'uiLibrary.deviceMeta.role.numericControl',
    labelFallback: 'Numeric control',
  },
  [DeviceRole.SelectControl]: {
    labelKey: 'uiLibrary.deviceMeta.role.selectControl',
    labelFallback: 'Select control',
  },
  [DeviceRole.TextControl]: {
    labelKey: 'uiLibrary.deviceMeta.role.textControl',
    labelFallback: 'Text control',
  },
  [DeviceRole.DateTimeControl]: {
    labelKey: 'uiLibrary.deviceMeta.role.dateTimeControl',
    labelFallback: 'Date / time control',
  },
  [DeviceRole.MobilePushNotifier]: {
    labelKey: 'uiLibrary.deviceMeta.role.mobilePushNotifier',
    labelFallback: 'Mobile push',
  },
  [DeviceRole.MessagingNotifier]: {
    labelKey: 'uiLibrary.deviceMeta.role.messagingNotifier',
    labelFallback: 'Messaging',
  },
  [DeviceRole.EmailNotifier]: {
    labelKey: 'uiLibrary.deviceMeta.role.emailNotifier',
    labelFallback: 'Email',
  },
  [DeviceRole.GenericNotifier]: {
    labelKey: 'uiLibrary.deviceMeta.role.genericNotifier',
    labelFallback: 'Notifier',
  },
  [DeviceRole.IrTransmitter]: {
    labelKey: 'uiLibrary.deviceMeta.role.irTransmitter',
    labelFallback: 'IR/RF transmitter',
  },
}

function withIcons<K extends string>(
  labels: Record<K, DeviceMetaLabel>,
  iconOf: (key: K) => LucideIcon,
): Record<K, DeviceMetaEntry> {
  const entries = Object.entries<DeviceMetaLabel>(labels).map(([key, label]) => {
    const k = key as K // documented boundary: Object.entries widens the record key to string
    return [key, { icon: iconOf(k), ...label }] as const
  })
  return Object.fromEntries(entries) as Record<K, DeviceMetaEntry> // same boundary, rebuilt from the exhaustive record
}

/** The type table — the icon comes from the shared resolver, the label from here. */
export const DEVICE_TYPE_META: Record<DeviceType, DeviceMetaEntry> = withIcons(
  DEVICE_TYPE_LABELS,
  (type) => FAST_ICON_GLYPHS[DEVICE_TYPE_ICON[type]],
)

/** The role table — the icon comes from the shared resolver, the label from here. */
export const DEVICE_ROLE_META: Record<DeviceRole, DeviceMetaEntry> = withIcons(
  DEVICE_ROLE_LABELS,
  (role) => FAST_ICON_GLYPHS[DEVICE_ROLE_ICON[role]],
)

const DEVICE_TYPE_VALUES = new Set<string>(Object.values(DeviceType))
const DEVICE_ROLE_VALUES = new Set<string>(Object.values(DeviceRole))

function isDeviceType(value: string): value is DeviceType {
  return DEVICE_TYPE_VALUES.has(value)
}
function isDeviceRole(value: string): value is DeviceRole {
  return DEVICE_ROLE_VALUES.has(value)
}

/** Meta for a known `DeviceType`. */
export function deviceTypeMeta(type: DeviceType, t: UiTextFn = defaultUiText): DeviceTypeMeta {
  return resolveMeta(DEVICE_TYPE_META[type], t)
}

/** Meta for a known `DeviceRole`. */
export function deviceRoleMeta(role: DeviceRole, t: UiTextFn = defaultUiText): DeviceRoleMeta {
  return resolveMeta(DEVICE_ROLE_META[role], t)
}

const FALLBACK_DEVICE_TYPE_META = DEVICE_TYPE_META[DeviceType.Generic]
const FALLBACK_DEVICE_ROLE_META = DEVICE_ROLE_META[DeviceRole.GenericSensor]

/**
 * Runtime-string-safe lookup: device data crosses process / network boundaries
 * as plain strings, so an unrecognised value falls back to the `Generic` meta
 * instead of throwing.
 *
 * This also guards mixed-version module-federation loads where the host
 * `@camstack/types` enum has a new member before the loaded ui-library bundle
 * has the matching `DEVICE_TYPE_META` entry.
 */
export function deviceTypeMetaOf(type: string, t: UiTextFn = defaultUiText): DeviceTypeMeta {
  if (!isDeviceType(type)) return resolveMeta(FALLBACK_DEVICE_TYPE_META, t)
  return resolveMeta(DEVICE_TYPE_META[type] ?? FALLBACK_DEVICE_TYPE_META, t)
}

/** Runtime-string-safe role lookup; unknown roles fall back to `GenericSensor`. */
export function deviceRoleMetaOf(role: string, t: UiTextFn = defaultUiText): DeviceRoleMeta {
  if (!isDeviceRole(role)) return resolveMeta(FALLBACK_DEVICE_ROLE_META, t)
  return resolveMeta(DEVICE_ROLE_META[role] ?? FALLBACK_DEVICE_ROLE_META, t)
}

/**
 * EXHAUSTIVE device-type filter options — one entry per `DeviceType` member,
 * derived from `DEVICE_TYPE_META` so the set is always complete and a newly
 * added `DeviceType` automatically appears in every type filter (Devices page,
 * adoption modal, …) without touching any consumer.
 *
 * The previous per-consumer logic built options from the types PRESENT in the
 * list (or a hand-maintained subset), so recently-added types (vacuum, lawn
 * mower, valve, humidifier, water heater, weather, image, …) were silently
 * missing from the dropdown. This is the single source of truth instead.
 *
 * `id` is the raw `DeviceType` string (matches the filtering predicate, which
 * compares against `device.type`); `label` + `icon` come from the meta map.
 * Ordered by `DeviceType` declaration order for a stable, intentional layout.
 */
function buildDeviceTypeFilterOptions(t: UiTextFn): readonly MultiSelectOption[] {
  return Object.values(DeviceType).map((type) => {
    const meta = deviceTypeMetaOf(type, t)
    return {
      id: type,
      label: meta.label,
      icon: meta.icon,
    }
  })
}

const DEFAULT_DEVICE_TYPE_FILTER_OPTIONS = buildDeviceTypeFilterOptions(defaultUiText)

export function allDeviceTypeFilterOptions(
  t: UiTextFn = defaultUiText,
): readonly MultiSelectOption[] {
  return t === defaultUiText ? DEFAULT_DEVICE_TYPE_FILTER_OPTIONS : buildDeviceTypeFilterOptions(t)
}
