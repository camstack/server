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
import { DeviceType, DeviceRole, type IconKey } from '@camstack/types'
import type { MultiSelectOption } from './device-list/multi-select'
import { defaultUiText, type UiTextFn } from '../contexts/ui-text'

/**
 * Single source of truth for rendering a device TYPE or ROLE: its icon + label.
 *
 * Both maps are `Record<DeviceType | DeviceRole, …>`, so adding a new enum
 * member makes the object literal incomplete and the build FAILS until the new
 * type/role is given an icon + label here. That is the whole point — UI never
 * silently falls back to a generic glyph for a freshly-added type/role.
 *
 * Lives in `@camstack/ui-library` because the icons are `lucide-react`
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

/** A table row: the label is a catalogue key + English fallback, resolved by the consumer. */
export interface DeviceMetaEntry {
  readonly icon: LucideIcon
  readonly labelKey: string
  readonly labelFallback: string
}

function resolveMeta(entry: DeviceMetaEntry, t: UiTextFn): DeviceTypeMeta {
  return { icon: entry.icon, label: t(entry.labelKey, entry.labelFallback) }
}

export const DEVICE_TYPE_META: Record<DeviceType, DeviceMetaEntry> = {
  [DeviceType.Camera]: {
    icon: Camera,
    labelKey: 'uiLibrary.deviceMeta.type.camera',
    labelFallback: 'Camera',
  },
  [DeviceType.Hub]: {
    icon: Network,
    labelKey: 'uiLibrary.deviceMeta.type.hub',
    labelFallback: 'Hub',
  },
  [DeviceType.Light]: {
    icon: Lightbulb,
    labelKey: 'uiLibrary.deviceMeta.type.light',
    labelFallback: 'Light',
  },
  [DeviceType.Siren]: {
    icon: Siren,
    labelKey: 'uiLibrary.deviceMeta.type.siren',
    labelFallback: 'Siren',
  },
  [DeviceType.Switch]: {
    icon: ToggleLeft,
    labelKey: 'uiLibrary.deviceMeta.type.switch',
    labelFallback: 'Switch',
  },
  [DeviceType.Sensor]: {
    icon: Activity,
    labelKey: 'uiLibrary.deviceMeta.type.sensor',
    labelFallback: 'Sensor',
  },
  [DeviceType.Thermostat]: {
    icon: Thermometer,
    labelKey: 'uiLibrary.deviceMeta.type.thermostat',
    labelFallback: 'Thermostat',
  },
  [DeviceType.Climate]: {
    icon: AirVent,
    labelKey: 'uiLibrary.deviceMeta.type.climate',
    labelFallback: 'Air conditioner',
  },
  [DeviceType.Button]: {
    icon: CircleDot,
    labelKey: 'uiLibrary.deviceMeta.type.button',
    labelFallback: 'Button',
  },
  [DeviceType.EventEmitter]: {
    icon: Zap,
    labelKey: 'uiLibrary.deviceMeta.type.eventEmitter',
    labelFallback: 'Event Emitter',
  },
  [DeviceType.Update]: {
    icon: RefreshCw,
    labelKey: 'uiLibrary.deviceMeta.type.update',
    labelFallback: 'Update',
  },
  [DeviceType.Generic]: {
    icon: Box,
    labelKey: 'uiLibrary.deviceMeta.type.generic',
    labelFallback: 'Generic',
  },
  [DeviceType.Notifier]: {
    icon: Bell,
    labelKey: 'uiLibrary.deviceMeta.type.notifier',
    labelFallback: 'Notifier',
  },
  [DeviceType.Script]: {
    icon: ScrollText,
    labelKey: 'uiLibrary.deviceMeta.type.script',
    labelFallback: 'Script',
  },
  [DeviceType.Automation]: {
    icon: Workflow,
    labelKey: 'uiLibrary.deviceMeta.type.automation',
    labelFallback: 'Automation',
  },
  [DeviceType.Lock]: {
    icon: Lock,
    labelKey: 'uiLibrary.deviceMeta.type.lock',
    labelFallback: 'Lock',
  },
  [DeviceType.Cover]: {
    icon: Blinds,
    labelKey: 'uiLibrary.deviceMeta.type.cover',
    labelFallback: 'Cover',
  },
  [DeviceType.Valve]: {
    icon: Pipette,
    labelKey: 'uiLibrary.deviceMeta.type.valve',
    labelFallback: 'Valve',
  },
  [DeviceType.Humidifier]: {
    icon: Waves,
    labelKey: 'uiLibrary.deviceMeta.type.humidifier',
    labelFallback: 'Humidifier',
  },
  [DeviceType.WaterHeater]: {
    icon: Bath,
    labelKey: 'uiLibrary.deviceMeta.type.waterHeater',
    labelFallback: 'Water heater',
  },
  [DeviceType.Fan]: { icon: Fan, labelKey: 'uiLibrary.deviceMeta.type.fan', labelFallback: 'Fan' },
  [DeviceType.MediaPlayer]: {
    icon: MonitorPlay,
    labelKey: 'uiLibrary.deviceMeta.type.mediaPlayer',
    labelFallback: 'Media player',
  },
  [DeviceType.AlarmPanel]: {
    icon: ShieldAlert,
    labelKey: 'uiLibrary.deviceMeta.type.alarmPanel',
    labelFallback: 'Alarm panel',
  },
  [DeviceType.Control]: {
    icon: SlidersHorizontal,
    labelKey: 'uiLibrary.deviceMeta.type.control',
    labelFallback: 'Control',
  },
  [DeviceType.Presence]: {
    icon: MapPin,
    labelKey: 'uiLibrary.deviceMeta.type.presence',
    labelFallback: 'Presence',
  },
  [DeviceType.Weather]: {
    icon: CloudSun,
    labelKey: 'uiLibrary.deviceMeta.type.weather',
    labelFallback: 'Weather',
  },
  [DeviceType.Vacuum]: {
    icon: Bot,
    labelKey: 'uiLibrary.deviceMeta.type.vacuum',
    labelFallback: 'Vacuum',
  },
  [DeviceType.LawnMower]: {
    icon: Tractor,
    labelKey: 'uiLibrary.deviceMeta.type.lawnMower',
    labelFallback: 'Lawn mower',
  },
  [DeviceType.Container]: {
    icon: Box,
    labelKey: 'uiLibrary.deviceMeta.type.container',
    labelFallback: 'Container',
  },
  [DeviceType.Image]: {
    icon: Image,
    labelKey: 'uiLibrary.deviceMeta.type.image',
    labelFallback: 'Image',
  },
  [DeviceType.PetFeeder]: {
    icon: Bone,
    labelKey: 'uiLibrary.deviceMeta.type.petFeeder',
    labelFallback: 'Pet feeder',
  },
  [DeviceType.Dishwasher]: {
    icon: Waves,
    labelKey: 'uiLibrary.deviceMeta.type.dishwasher',
    labelFallback: 'Dishwasher',
  },
  [DeviceType.Washer]: {
    icon: WashingMachine,
    labelKey: 'uiLibrary.deviceMeta.type.washer',
    labelFallback: 'Washing machine',
  },
  [DeviceType.Dryer]: {
    icon: Wind,
    labelKey: 'uiLibrary.deviceMeta.type.dryer',
    labelFallback: 'Dryer',
  },
}

export const DEVICE_ROLE_META: Record<DeviceRole, DeviceMetaEntry> = {
  [DeviceRole.Siren]: {
    icon: Siren,
    labelKey: 'uiLibrary.deviceMeta.role.siren',
    labelFallback: 'Siren',
  },
  [DeviceRole.Floodlight]: {
    icon: Lightbulb,
    labelKey: 'uiLibrary.deviceMeta.role.floodlight',
    labelFallback: 'Floodlight',
  },
  [DeviceRole.Spotlight]: {
    icon: Flashlight,
    labelKey: 'uiLibrary.deviceMeta.role.spotlight',
    labelFallback: 'Spotlight',
  },
  [DeviceRole.PirSensor]: {
    icon: Radar,
    labelKey: 'uiLibrary.deviceMeta.role.pirSensor',
    labelFallback: 'PIR sensor',
  },
  [DeviceRole.Chime]: {
    icon: Bell,
    labelKey: 'uiLibrary.deviceMeta.role.chime',
    labelFallback: 'Chime',
  },
  [DeviceRole.Autotrack]: {
    icon: Crosshair,
    labelKey: 'uiLibrary.deviceMeta.role.autotrack',
    labelFallback: 'Auto-track',
  },
  [DeviceRole.Nightvision]: {
    icon: Moon,
    labelKey: 'uiLibrary.deviceMeta.role.nightvision',
    labelFallback: 'Night vision',
  },
  [DeviceRole.PrivacyMask]: {
    icon: EyeOff,
    labelKey: 'uiLibrary.deviceMeta.role.privacyMask',
    labelFallback: 'Privacy mask',
  },
  [DeviceRole.Doorbell]: {
    icon: DoorClosed,
    labelKey: 'uiLibrary.deviceMeta.role.doorbell',
    labelFallback: 'Doorbell',
  },
  [DeviceRole.CoverBlind]: {
    icon: Blinds,
    labelKey: 'uiLibrary.deviceMeta.role.coverBlind',
    labelFallback: 'Blind',
  },
  [DeviceRole.CoverShutter]: {
    icon: Blinds,
    labelKey: 'uiLibrary.deviceMeta.role.coverShutter',
    labelFallback: 'Shutter',
  },
  [DeviceRole.CoverAwning]: {
    icon: Blinds,
    labelKey: 'uiLibrary.deviceMeta.role.coverAwning',
    labelFallback: 'Awning',
  },
  [DeviceRole.CoverCurtain]: {
    icon: Blinds,
    labelKey: 'uiLibrary.deviceMeta.role.coverCurtain',
    labelFallback: 'Curtain',
  },
  [DeviceRole.CoverGarage]: {
    icon: DoorClosed,
    labelKey: 'uiLibrary.deviceMeta.role.coverGarage',
    labelFallback: 'Garage door',
  },
  [DeviceRole.CoverGate]: {
    icon: DoorClosed,
    labelKey: 'uiLibrary.deviceMeta.role.coverGate',
    labelFallback: 'Gate',
  },
  [DeviceRole.CoverDoor]: {
    icon: DoorOpen,
    labelKey: 'uiLibrary.deviceMeta.role.coverDoor',
    labelFallback: 'Door',
  },
  [DeviceRole.CoverWindow]: {
    icon: Blinds,
    labelKey: 'uiLibrary.deviceMeta.role.coverWindow',
    labelFallback: 'Window',
  },
  [DeviceRole.BinaryHelper]: {
    icon: ToggleLeft,
    labelKey: 'uiLibrary.deviceMeta.role.binaryHelper',
    labelFallback: 'Binary helper',
  },
  [DeviceRole.Outlet]: {
    icon: Plug,
    labelKey: 'uiLibrary.deviceMeta.role.outlet',
    labelFallback: 'Outlet',
  },
  [DeviceRole.MotionSensor]: {
    icon: Footprints,
    labelKey: 'uiLibrary.deviceMeta.role.motionSensor',
    labelFallback: 'Motion sensor',
  },
  [DeviceRole.ContactSensor]: {
    icon: DoorOpen,
    labelKey: 'uiLibrary.deviceMeta.role.contactSensor',
    labelFallback: 'Contact sensor',
  },
  [DeviceRole.LeakSensor]: {
    icon: Droplet,
    labelKey: 'uiLibrary.deviceMeta.role.leakSensor',
    labelFallback: 'Leak sensor',
  },
  [DeviceRole.SmokeSensor]: {
    icon: AlarmSmoke,
    labelKey: 'uiLibrary.deviceMeta.role.smokeSensor',
    labelFallback: 'Smoke sensor',
  },
  [DeviceRole.COSensor]: {
    icon: Wind,
    labelKey: 'uiLibrary.deviceMeta.role.cOSensor',
    labelFallback: 'CO sensor',
  },
  [DeviceRole.GasSensor]: {
    icon: Flame,
    labelKey: 'uiLibrary.deviceMeta.role.gasSensor',
    labelFallback: 'Gas sensor',
  },
  [DeviceRole.TamperSensor]: {
    icon: ShieldAlert,
    labelKey: 'uiLibrary.deviceMeta.role.tamperSensor',
    labelFallback: 'Tamper sensor',
  },
  [DeviceRole.VibrationSensor]: {
    icon: Vibrate,
    labelKey: 'uiLibrary.deviceMeta.role.vibrationSensor',
    labelFallback: 'Vibration sensor',
  },
  [DeviceRole.ConnectivitySensor]: {
    icon: Wifi,
    labelKey: 'uiLibrary.deviceMeta.role.connectivitySensor',
    labelFallback: 'Connectivity',
  },
  [DeviceRole.SoundSensor]: {
    icon: Volume2,
    labelKey: 'uiLibrary.deviceMeta.role.soundSensor',
    labelFallback: 'Sound sensor',
  },
  [DeviceRole.BinarySensor]: {
    icon: ToggleLeft,
    labelKey: 'uiLibrary.deviceMeta.role.binarySensor',
    labelFallback: 'Binary sensor',
  },
  [DeviceRole.TemperatureSensor]: {
    icon: Thermometer,
    labelKey: 'uiLibrary.deviceMeta.role.temperatureSensor',
    labelFallback: 'Temperature',
  },
  [DeviceRole.HumiditySensor]: {
    icon: Droplets,
    labelKey: 'uiLibrary.deviceMeta.role.humiditySensor',
    labelFallback: 'Humidity',
  },
  [DeviceRole.AmbientLightSensor]: {
    icon: Sun,
    labelKey: 'uiLibrary.deviceMeta.role.ambientLightSensor',
    labelFallback: 'Ambient light',
  },
  [DeviceRole.PressureSensor]: {
    icon: Gauge,
    labelKey: 'uiLibrary.deviceMeta.role.pressureSensor',
    labelFallback: 'Pressure',
  },
  [DeviceRole.WindSensor]: {
    icon: Wind,
    labelKey: 'uiLibrary.deviceMeta.role.windSensor',
    labelFallback: 'Wind',
  },
  [DeviceRole.RainSensor]: {
    icon: CloudRain,
    labelKey: 'uiLibrary.deviceMeta.role.rainSensor',
    labelFallback: 'Rain',
  },
  [DeviceRole.UvSensor]: {
    icon: SunMedium,
    labelKey: 'uiLibrary.deviceMeta.role.uvSensor',
    labelFallback: 'UV index',
  },
  [DeviceRole.SolarRadiationSensor]: {
    icon: Sunrise,
    labelKey: 'uiLibrary.deviceMeta.role.solarRadiationSensor',
    labelFallback: 'Solar radiation',
  },
  [DeviceRole.SoilMoistureSensor]: {
    icon: Sprout,
    labelKey: 'uiLibrary.deviceMeta.role.soilMoistureSensor',
    labelFallback: 'Soil moisture',
  },
  [DeviceRole.PowerSensor]: {
    icon: Zap,
    labelKey: 'uiLibrary.deviceMeta.role.powerSensor',
    labelFallback: 'Power',
  },
  [DeviceRole.EnergySensor]: {
    icon: Zap,
    labelKey: 'uiLibrary.deviceMeta.role.energySensor',
    labelFallback: 'Energy',
  },
  [DeviceRole.VoltageSensor]: {
    icon: Zap,
    labelKey: 'uiLibrary.deviceMeta.role.voltageSensor',
    labelFallback: 'Voltage',
  },
  [DeviceRole.CurrentSensor]: {
    icon: Zap,
    labelKey: 'uiLibrary.deviceMeta.role.currentSensor',
    labelFallback: 'Current',
  },
  [DeviceRole.AirQualitySensor]: {
    icon: Wind,
    labelKey: 'uiLibrary.deviceMeta.role.airQualitySensor',
    labelFallback: 'Air quality',
  },
  [DeviceRole.BatterySensor]: {
    icon: Gauge,
    labelKey: 'uiLibrary.deviceMeta.role.batterySensor',
    labelFallback: 'Battery',
  },
  [DeviceRole.NumericSensor]: {
    icon: Hash,
    labelKey: 'uiLibrary.deviceMeta.role.numericSensor',
    labelFallback: 'Numeric sensor',
  },
  [DeviceRole.EnumSensor]: {
    icon: List,
    labelKey: 'uiLibrary.deviceMeta.role.enumSensor',
    labelFallback: 'Enum sensor',
  },
  [DeviceRole.DateTimeSensor]: {
    icon: Clock,
    labelKey: 'uiLibrary.deviceMeta.role.dateTimeSensor',
    labelFallback: 'Date / time',
  },
  [DeviceRole.GenericSensor]: {
    icon: Gauge,
    labelKey: 'uiLibrary.deviceMeta.role.genericSensor',
    labelFallback: 'Sensor',
  },
  [DeviceRole.NumericControl]: {
    icon: SlidersHorizontal,
    labelKey: 'uiLibrary.deviceMeta.role.numericControl',
    labelFallback: 'Numeric control',
  },
  [DeviceRole.SelectControl]: {
    icon: ListChecks,
    labelKey: 'uiLibrary.deviceMeta.role.selectControl',
    labelFallback: 'Select control',
  },
  [DeviceRole.TextControl]: {
    icon: Type,
    labelKey: 'uiLibrary.deviceMeta.role.textControl',
    labelFallback: 'Text control',
  },
  [DeviceRole.DateTimeControl]: {
    icon: Clock,
    labelKey: 'uiLibrary.deviceMeta.role.dateTimeControl',
    labelFallback: 'Date / time control',
  },
  [DeviceRole.MobilePushNotifier]: {
    icon: Smartphone,
    labelKey: 'uiLibrary.deviceMeta.role.mobilePushNotifier',
    labelFallback: 'Mobile push',
  },
  [DeviceRole.MessagingNotifier]: {
    icon: MessageSquare,
    labelKey: 'uiLibrary.deviceMeta.role.messagingNotifier',
    labelFallback: 'Messaging',
  },
  [DeviceRole.EmailNotifier]: {
    icon: Mail,
    labelKey: 'uiLibrary.deviceMeta.role.emailNotifier',
    labelFallback: 'Email',
  },
  [DeviceRole.GenericNotifier]: {
    icon: Bell,
    labelKey: 'uiLibrary.deviceMeta.role.genericNotifier',
    labelFallback: 'Notifier',
  },
  [DeviceRole.IrTransmitter]: {
    icon: RadioTower,
    labelKey: 'uiLibrary.deviceMeta.role.irTransmitter',
    labelFallback: 'IR/RF transmitter',
  },
}

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
 * The glyphs the admin draws on FIRST PAINT, synchronously — the ones the
 * device-type and role meta tables above already import. Everything else in
 * the icon catalog is drawn from the lazily loaded full table
 * (`icon-glyphs.ts`), so the initial chunk carries ~60 lucide icons instead of
 * one static import per catalog key (D854).
 *
 * Typed `Partial<Record<IconKey, ...>>`: a key that is not in the catalog is a
 * compile error, so this table can never become a second vocabulary — it is a
 * cache of glyphs, not a list of choices.
 */
export const FAST_ICON_GLYPHS: Readonly<Partial<Record<IconKey, LucideIcon>>> = {
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
