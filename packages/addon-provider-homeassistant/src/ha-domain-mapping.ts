import {
  DeviceType,
  DeviceRole,
  DeviceFeature,
  type EnumSensorDateTimeFormat,
} from '@camstack/types'

/**
 * HA domain + device_class → CamStack materialisation triplet. The
 * function is pure: same inputs always yield the same mapping. Called
 * once per HA entity at discovery time to pre-populate
 * `HaDiscoveredEntity.mappedTo` so the adoption preview is a no-
 * roundtrip render.
 *
 * Returns `null` when the entity's domain has no supported mapping
 * (unmapped/future domains fall through to `null` until their caps land).
 * HA `camera.*` entities map to a read-only Image device (the signed
 * `entity_picture` still), same as `image.*` — no streaming, no stream broker.
 */

export interface HaEntityMapping {
  readonly deviceType: DeviceType
  readonly role: DeviceRole | null
  /**
   * Capability names that should register on the accessory child device.
   * Cap names match the CamStack cap registry (`switch`, `brightness`,
   * `color`, `temperature-sensor`, …).
   */
  readonly capabilities: readonly string[]
  /** Optional DeviceFeature flags to set on the accessory child. The HA
   *  addon's adoption flow writes these to `device.features` so the UI
   *  gates sub-controls without a slice fetch. */
  readonly features?: readonly DeviceFeature[]
  /** Locale-render shape for a `DateTimeSensor`-role enum sensor: HA
   *  `device_class=timestamp` → `'datetime'`, `device_class=date` → `'date'`,
   *  a time-only sensor → `'time'`. Threaded to the child config so the
   *  enum-sensor device seeds it into the cap slice and the UI renders the
   *  ISO `value` locale-formatted. Absent for every non-DateTimeSensor mapping. */
  readonly dateTimeFormat?: EnumSensorDateTimeFormat
}

export interface HaEntityMappingInput {
  readonly domain: string
  readonly deviceClass: string | null
  /** Full HA attribute bag — used by mappings that need richer signals
   *  (light's `supported_color_modes`, fan's `supported_features`, …). */
  readonly attributes: Record<string, unknown>
}

export function mapHaEntityToCamStack(input: HaEntityMappingInput): HaEntityMapping | null {
  const { domain, deviceClass, attributes } = input
  switch (domain) {
    // ── Switch family ─────────────────────────────────────────────────
    case 'switch':
      // `device_class: outlet` marks a smart plug (D875): the role lets an
      // exporter show it as a plug instead of a generic switch.
      return {
        deviceType: DeviceType.Switch,
        role: deviceClass === 'outlet' ? DeviceRole.Outlet : null,
        capabilities: ['switch'],
      }
    case 'input_boolean':
      return {
        deviceType: DeviceType.Switch,
        role: DeviceRole.BinaryHelper,
        capabilities: ['switch'],
      }
    case 'remote':
      // HA `remote.*` exposes on/off (send_command is out of scope). The
      // generic switch device derives the `remote` service domain from the
      // entity_id prefix, so `remote.turn_on/turn_off` works unchanged.
      return { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] }
    case 'siren':
      // HA `siren.*` exposes on/off (tone/volume params are out of scope).
      // Reuses the generic switch device; only the DeviceType differs so the
      // UI renders a klaxon affordance.
      return { deviceType: DeviceType.Siren, role: null, capabilities: ['switch'] }

    // ── Update (firmware/software descriptor) ──────────────────────────
    case 'update':
      // HA `update.*` entity — `state === 'on'` means an update is available.
      // Versions + progress flow live through the `update` cap slice.
      return { deviceType: DeviceType.Update, role: null, capabilities: ['update'] }

    // ── Light ─────────────────────────────────────────────────────────
    case 'light':
      return mapLight(attributes)

    // ── Lock / Cover / Fan ─────────────────────────────────────────────
    case 'lock':
      return mapLock(attributes)
    case 'cover':
      return mapCover(attributes, deviceClass)
    case 'valve':
      return mapValve(attributes, deviceClass)
    case 'humidifier':
      return mapHumidifier(attributes, deviceClass)
    case 'water_heater':
      return mapWaterHeater(attributes, deviceClass)
    case 'fan':
      return mapFan(attributes)

    // ── Robots (vacuum / lawn mower) ────────────────────────────────────
    case 'vacuum':
      return mapVacuum(attributes)
    case 'lawn_mower':
      return mapLawnMower(attributes)

    // ── Climate / Media / Alarm ────────────────────────────────────────
    case 'climate':
      return mapClimate(attributes)
    case 'media_player':
      return mapMediaPlayer(attributes)
    case 'alarm_control_panel':
      return mapAlarmPanel(attributes)

    // ── Presence ──────────────────────────────────────────────────────
    case 'person':
    case 'device_tracker':
      return { deviceType: DeviceType.Presence, role: null, capabilities: ['presence'] }

    // ── Read-only display (weather / image) ────────────────────────────
    case 'weather':
      return mapWeather(attributes)
    case 'image':
      return mapImage(attributes)

    // ── Camera → modelled as a read-only Image ─────────────────────────
    // HA `camera.*` exposes a still via the signed `entity_picture` URL, just
    // like `image.*`. We model it as an Image device (not a streamable Camera)
    // so snapshot-only sources (e.g. a vacuum map) render as a plain image and
    // never engage the stream broker. Streaming HA cameras are better adopted
    // through CamStack's native ONVIF/RTSP providers.
    case 'camera':
      return mapImage(attributes)

    // ── User-settable inputs (Control) ─────────────────────────────────
    case 'number':
    case 'input_number':
      return {
        deviceType: DeviceType.Control,
        role: DeviceRole.NumericControl,
        capabilities: ['control'],
      }
    case 'select':
    case 'input_select':
      return {
        deviceType: DeviceType.Control,
        role: DeviceRole.SelectControl,
        capabilities: ['control'],
      }
    case 'text':
    case 'input_text':
      return {
        deviceType: DeviceType.Control,
        role: DeviceRole.TextControl,
        capabilities: ['control'],
      }
    case 'input_datetime':
    case 'date':
    case 'time':
    case 'datetime':
      // All four map to the datetime control kind. The concrete date/time/
      // datetime sub-format is derived by the device from its HA domain (and,
      // for input_datetime, from the entity's has_date/has_time attributes).
      return {
        deviceType: DeviceType.Control,
        role: DeviceRole.DateTimeControl,
        capabilities: ['control'],
      }

    // ── Fire-only actuators ────────────────────────────────────────────
    case 'button':
    case 'input_button':
    case 'scene':
      // `scene` reuses the Button type + `button` cap; HaButtonDevice
      // dispatches scene.turn_on instead of <domain>.press per entity domain.
      return { deviceType: DeviceType.Button, role: null, capabilities: ['button'] }

    // ── Event emitter (structured, fire-only) ──────────────────────────
    //   HA `event.*` entity = one button-channel emitter. The device
    //   carries the entity's EXACT declared `event_types` vocabulary
    //   verbatim (NO normalization); each fire reports `event_type` as-is.
    case 'event':
      return { deviceType: DeviceType.EventEmitter, role: null, capabilities: ['event-emitter'] }

    // ── Imperative ────────────────────────────────────────────────────
    case 'script':
      return { deviceType: DeviceType.Script, role: null, capabilities: ['script-runner'] }
    case 'automation':
      return { deviceType: DeviceType.Automation, role: null, capabilities: ['automation-control'] }
    case 'notify':
      return mapNotifier(attributes)

    // ── Sensors (numeric + binary) ─────────────────────────────────────
    case 'sensor':
      return mapNumericSensor(deviceClass, attributes)
    case 'binary_sensor':
      return mapBinarySensor(deviceClass)

    // ── Unsupported / future domains ───────────────────────────────────
    default:
      return null
  }
}

// ── Light mapping ───────────────────────────────────────────────────────

function mapLight(attributes: Record<string, unknown>): HaEntityMapping {
  const capabilities: string[] = ['switch']
  const features: DeviceFeature[] = []

  const supportedColorModes = attributes['supported_color_modes']
  const modes = Array.isArray(supportedColorModes) ? supportedColorModes.map((v) => String(v)) : []

  // Brightness: any color_mode that isn't `onoff` implies dim support.
  if (modes.length > 0 && !modes.every((m) => m === 'onoff')) {
    capabilities.push('brightness')
  }

  const hasRgb = modes.some((m) => ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'].includes(m))
  const hasMired = modes.some((m) => m === 'color_temp')
  if (hasRgb || hasMired) {
    capabilities.push('color')
    if (
      modes.includes('rgb') ||
      modes.includes('rgbw') ||
      modes.includes('rgbww') ||
      modes.includes('xy')
    ) {
      features.push(DeviceFeature.LightColorRgb)
    }
    if (modes.includes('hs')) features.push(DeviceFeature.LightColorHsv)
    if (hasMired) features.push(DeviceFeature.LightColorMired)
  }

  return {
    deviceType: DeviceType.Light,
    role: null,
    capabilities,
    features,
  }
}

// ── Lock mapping ────────────────────────────────────────────────────────

function mapLock(attributes: Record<string, unknown>): HaEntityMapping {
  const features: DeviceFeature[] = []
  if (attributes['code_format'] !== undefined && attributes['code_format'] !== null) {
    features.push(DeviceFeature.LockPinRequired)
  }
  // HA lock supported_features bitmask:
  //  - OPEN = 1 → latch-release "open door" action available
  const sf = readNumericAttr(attributes, 'supported_features')
  if (sf !== null && (sf & 1) !== 0) features.push(DeviceFeature.LockOpen)
  return {
    deviceType: DeviceType.Lock,
    role: null,
    capabilities: ['lock-control'],
    features,
  }
}

// ── Cover mapping ───────────────────────────────────────────────────────

function mapCover(
  attributes: Record<string, unknown>,
  deviceClass: string | null,
): HaEntityMapping {
  const features: DeviceFeature[] = []
  const sf = readNumericAttr(attributes, 'supported_features')
  // HA cover supported_features bitmask (subset):
  //  - SET_POSITION = 4
  //  - SET_TILT_POSITION = 128
  if (sf !== null && (sf & 4) !== 0) features.push(DeviceFeature.CoverPositionable)
  if (sf !== null && (sf & 128) !== 0) features.push(DeviceFeature.CoverTilt)

  // Role = the KIND of cover, from HA `device_class`; the cap surface itself is
  // identical. Exporters read it to pick a blind, a garage door or a gate.
  return {
    deviceType: DeviceType.Cover,
    role: coverRoleFor(deviceClass),
    capabilities: ['cover'],
    features,
  }
}

/** The cover KIND for an HA cover `device_class`; null for none / `damper`. */
export function coverRoleFor(deviceClass: string | null): DeviceRole | null {
  switch (deviceClass) {
    case 'blind':
    case 'shade':
      return DeviceRole.CoverBlind
    case 'shutter':
      return DeviceRole.CoverShutter
    case 'awning':
      return DeviceRole.CoverAwning
    case 'curtain':
      return DeviceRole.CoverCurtain
    case 'garage':
      return DeviceRole.CoverGarage
    case 'gate':
      return DeviceRole.CoverGate
    case 'door':
      return DeviceRole.CoverDoor
    case 'window':
      return DeviceRole.CoverWindow
    default:
      return null
  }
}

// ── Valve mapping ───────────────────────────────────────────────────────

function mapValve(
  attributes: Record<string, unknown>,
  _deviceClass: string | null,
): HaEntityMapping {
  const features: DeviceFeature[] = []
  const sf = readNumericAttr(attributes, 'supported_features')
  // HA valve supported_features bitmask:
  //  - OPEN = 1, CLOSE = 2, SET_POSITION = 4, STOP = 8
  if (sf !== null && (sf & 4) !== 0) features.push(DeviceFeature.ValvePositionable)
  return {
    deviceType: DeviceType.Valve,
    role: null,
    capabilities: ['valve'],
    features,
  }
}

// ── Humidifier mapping ──────────────────────────────────────────────────

function mapHumidifier(
  _attributes: Record<string, unknown>,
  _deviceClass: string | null,
): HaEntityMapping {
  // HA `humidifier.*` → humidifier cap. Target humidity / mode / action are
  // surfaced live through the cap slice on each state push (not as
  // DeviceFeature flags).
  return {
    deviceType: DeviceType.Humidifier,
    role: null,
    capabilities: ['humidifier'],
    features: [],
  }
}

// ── Water heater mapping ────────────────────────────────────────────────

function mapWaterHeater(
  _attributes: Record<string, unknown>,
  _deviceClass: string | null,
): HaEntityMapping {
  // HA `water_heater.*` → water-heater cap. Target temp / operation mode /
  // away are surfaced live through the cap slice on each state push.
  return {
    deviceType: DeviceType.WaterHeater,
    role: null,
    capabilities: ['water-heater'],
    features: [],
  }
}

// ── Fan mapping ─────────────────────────────────────────────────────────

function mapFan(attributes: Record<string, unknown>): HaEntityMapping {
  const features: DeviceFeature[] = []
  const sf = readNumericAttr(attributes, 'supported_features')
  // HA fan supported_features bitmask (subset):
  //  - SET_SPEED = 1
  //  - OSCILLATE = 2
  //  - DIRECTION = 4
  //  - PRESET_MODE = 8
  if (sf !== null) {
    if ((sf & 1) !== 0) features.push(DeviceFeature.FanSpeed)
    if ((sf & 2) !== 0) features.push(DeviceFeature.FanOscillating)
    if ((sf & 4) !== 0) features.push(DeviceFeature.FanDirection)
    if ((sf & 8) !== 0) features.push(DeviceFeature.FanPreset)
  }
  return {
    deviceType: DeviceType.Fan,
    role: null,
    // Fan registers BOTH switch (on/off) AND fan-control (speed +
    // preset + direction + oscillating).
    capabilities: ['switch', 'fan-control'],
    features,
  }
}

// ── Vacuum mapping ──────────────────────────────────────────────────────

function mapVacuum(_attributes: Record<string, unknown>): HaEntityMapping {
  // HA `vacuum.*` → robot-vacuum cap. Battery / fan-speed are surfaced live
  // through the cap slice on each state push (not as DeviceFeature flags).
  return {
    deviceType: DeviceType.Vacuum,
    role: null,
    capabilities: ['vacuum-control'],
    features: [],
  }
}

// ── Lawn-mower mapping ──────────────────────────────────────────────────

function mapLawnMower(_attributes: Record<string, unknown>): HaEntityMapping {
  // HA `lawn_mower.*` → robotic lawn-mower cap. Battery is surfaced live
  // through the cap slice on each state push (not as a DeviceFeature flag).
  return {
    deviceType: DeviceType.LawnMower,
    role: null,
    capabilities: ['lawn-mower-control'],
    features: [],
  }
}

// ── Climate mapping ─────────────────────────────────────────────────────

function mapClimate(attributes: Record<string, unknown>): HaEntityMapping {
  const features: DeviceFeature[] = []
  const sf = readNumericAttr(attributes, 'supported_features')
  // HA climate supported_features bitmask (subset):
  //  - TARGET_TEMPERATURE_RANGE = 2  → dual-setpoint heat_cool
  //  - TARGET_HUMIDITY = 4
  //  - FAN_MODE = 8
  //  - PRESET_MODE = 16
  if (sf !== null) {
    if ((sf & 2) !== 0) features.push(DeviceFeature.ClimateDualSetpoint)
    if ((sf & 4) !== 0) features.push(DeviceFeature.ClimateHumidity)
    if ((sf & 8) !== 0) features.push(DeviceFeature.ClimateFanMode)
    if ((sf & 16) !== 0) features.push(DeviceFeature.ClimatePreset)
  }
  return {
    deviceType: DeviceType.Thermostat,
    role: null,
    capabilities: ['climate-control'],
    features,
  }
}

// ── Media player mapping ────────────────────────────────────────────────

function mapMediaPlayer(attributes: Record<string, unknown>): HaEntityMapping {
  const features: DeviceFeature[] = []
  const sf = readNumericAttr(attributes, 'supported_features')
  // HA media_player supported_features bitmask:
  //  - PAUSE = 1, SEEK = 2, VOLUME_SET = 4, VOLUME_MUTE = 8,
  //    PREVIOUS_TRACK = 16, NEXT_TRACK = 32, TURN_ON = 128,
  //    TURN_OFF = 256, PLAY_MEDIA = 512, VOLUME_STEP = 1024,
  //    SELECT_SOURCE = 2048, STOP = 4096, CLEAR_PLAYLIST = 8192,
  //    PLAY = 16384, SHUFFLE_SET = 32768, SELECT_SOUND_MODE = 65536,
  //    BROWSE_MEDIA = 131072, REPEAT_SET = 262144.
  if (sf !== null) {
    if ((sf & 2) !== 0) features.push(DeviceFeature.MediaPlayerSeek)
    if ((sf & 4) !== 0) features.push(DeviceFeature.MediaPlayerVolume)
    if ((sf & 8) !== 0) features.push(DeviceFeature.MediaPlayerMute)
    if ((sf & 16) !== 0) features.push(DeviceFeature.MediaPlayerPrevious)
    if ((sf & 32) !== 0) features.push(DeviceFeature.MediaPlayerNext)
    if ((sf & 512) !== 0) features.push(DeviceFeature.MediaPlayerPlayMedia)
    if ((sf & 2048) !== 0) features.push(DeviceFeature.MediaPlayerSelectSource)
    if ((sf & 4096) !== 0) features.push(DeviceFeature.MediaPlayerStop)
    if ((sf & 32768) !== 0) features.push(DeviceFeature.MediaPlayerShuffle)
    if ((sf & 262144) !== 0) features.push(DeviceFeature.MediaPlayerRepeat)
  }
  return {
    deviceType: DeviceType.MediaPlayer,
    role: null,
    capabilities: ['media-player'],
    features,
  }
}

// ── Alarm panel mapping ─────────────────────────────────────────────────

function mapAlarmPanel(attributes: Record<string, unknown>): HaEntityMapping {
  const features: DeviceFeature[] = []
  if (attributes['code_format'] !== undefined && attributes['code_format'] !== null) {
    features.push(DeviceFeature.AlarmPinRequired)
  }
  return {
    deviceType: DeviceType.AlarmPanel,
    role: null,
    capabilities: ['alarm-panel'],
    features,
  }
}

// ── Notifier mapping ────────────────────────────────────────────────────

function mapNotifier(_attributes: Record<string, unknown>): HaEntityMapping {
  // HA exposes notify.<service> as a SERVICE not an entity in newer
  // versions; the addon synthesises a discovery entry. Role
  // differentiation (mobile / messaging / email / generic) is up to
  // the addon based on the service name. Default to GenericNotifier
  // here; the adoption flow may override.
  return {
    deviceType: DeviceType.Notifier,
    role: DeviceRole.GenericNotifier,
    capabilities: ['notifier'],
  }
}

// ── Weather mapping ─────────────────────────────────────────────────────

function mapWeather(_attributes: Record<string, unknown>): HaEntityMapping {
  // HA `weather.*` → read-only weather cap. Current conditions
  // (condition / temperature / humidity / pressure / wind) are surfaced
  // live through the cap slice on each state push.
  return {
    deviceType: DeviceType.Weather,
    role: null,
    capabilities: ['weather'],
  }
}

// ── Image mapping ───────────────────────────────────────────────────────

function mapImage(_attributes: Record<string, unknown>): HaEntityMapping {
  // HA `image.*` → read-only image cap. The signed `entity_picture` URL
  // is resolved + surfaced live through the cap slice on each state push.
  return {
    deviceType: DeviceType.Image,
    role: null,
    capabilities: ['image'],
  }
}

// ── Numeric sensor mapping (sensor.*) ───────────────────────────────────

/** True when HA `unit_of_measurement` clearly means temperature (°C / °F). */
function isTemperatureUnit(unit: unknown): boolean {
  if (typeof unit !== 'string') return false
  const n = unit.trim().toLowerCase().replace(/\s+/g, '')
  return (
    n === '°c' ||
    n === '°f' ||
    n === '℃' ||
    n === '℉' ||
    n === 'c' ||
    n === 'f' ||
    n === 'celsius' ||
    n === 'fahrenheit'
  )
}

function mapNumericSensor(
  deviceClass: string | null,
  _attributes: Record<string, unknown>,
): HaEntityMapping {
  switch (deviceClass) {
    case 'temperature':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.TemperatureSensor,
        capabilities: ['temperature-sensor'],
      }
    case 'humidity':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.HumiditySensor,
        capabilities: ['humidity-sensor'],
      }
    case 'illuminance':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.AmbientLightSensor,
        capabilities: ['ambient-light-sensor'],
      }
    case 'pressure':
    case 'atmospheric_pressure':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.PressureSensor,
        capabilities: ['pressure-sensor'],
      }
    // ── Weather metrics: numeric-sensor + a typed role (icon/label). Same
    //    pattern as `battery` below — no dedicated per-metric cap. ──
    case 'wind_speed':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.WindSensor,
        capabilities: ['numeric-sensor'],
      }
    case 'precipitation':
    case 'precipitation_intensity':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.RainSensor,
        capabilities: ['numeric-sensor'],
      }
    case 'irradiance':
      // Solar irradiance (W/m²) — distinct from `illuminance` (lux), which maps
      // to ambient-light above.
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.SolarRadiationSensor,
        capabilities: ['numeric-sensor'],
      }
    case 'power':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.PowerSensor,
        capabilities: ['power-meter'],
      }
    case 'energy':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.EnergySensor,
        capabilities: ['power-meter'],
      }
    case 'voltage':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.VoltageSensor,
        capabilities: ['power-meter'],
      }
    case 'current':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.CurrentSensor,
        capabilities: ['power-meter'],
      }
    case 'pm1':
    case 'pm10':
    case 'pm25':
    case 'co':
    case 'co2':
    case 'nitrogen_dioxide':
    case 'ozone':
    case 'sulphur_dioxide':
    case 'volatile_organic_compounds':
    case 'aqi':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.AirQualitySensor,
        capabilities: ['air-quality-sensor'],
      }
    case 'battery':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.BatterySensor,
        capabilities: ['numeric-sensor'],
      }
    case 'enum':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.EnumSensor,
        capabilities: ['enum-sensor'],
      }
    case 'timestamp':
      // HA `device_class=timestamp` sensors expose their value as a full ISO
      // datetime STRING in state.state (e.g. '2025-12-02T09:36:12+00:00').
      // Number() on that yields NaN which the numeric decode silently drops —
      // so host the raw string on the enum-sensor cap (which stores state.state
      // verbatim) and tag the role DateTimeSensor with a 'datetime' format so
      // the UI renders it locale-formatted instead of as a raw string / 0.
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.DateTimeSensor,
        capabilities: ['enum-sensor'],
        dateTimeFormat: 'datetime',
      }
    case 'date':
      // HA `device_class=date` sensors expose a date-only STRING (e.g.
      // '2025-12-02'). Same enum-sensor hosting as timestamp, but a 'date'
      // format so the UI omits the time-of-day component.
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.DateTimeSensor,
        capabilities: ['enum-sensor'],
        dateTimeFormat: 'date',
      }
    // TODO time-only: HA has no `device_class` for a pure time-of-day sensor
    // (the `time.*` domain is a SETTABLE control, not a sensor), so 'time' is
    // not cleanly detectable here. The 'time' format is supported end-to-end
    // (cap slice + UI) for when a time-only signal becomes detectable.
    case null: {
      // Helpers / statistics / template sensors often omit device_class but
      // still carry a clear temperature unit (°C / °F). Infer temperature so
      // those values adopt as TemperatureSensor instead of free-text enum.
      // Do NOT infer humidity from bare `%` — battery and many other sensors
      // share that unit.
      if (isTemperatureUnit(_attributes['unit_of_measurement'])) {
        return {
          deviceType: DeviceType.Sensor,
          role: DeviceRole.TemperatureSensor,
          capabilities: ['temperature-sensor'],
        }
      }
      // No device_class — HA free-text sensors (IP, SSID, firmware version,
      // status strings, …). Number() on a string value yields NaN which the
      // numeric decode silently drops. Map to enum-sensor so the raw string
      // state is stored verbatim and the UI renders it as text.
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.EnumSensor,
        capabilities: ['enum-sensor'],
      }
    }
    default:
      // Numeric fallback for unknown but non-null device_class values
      // (signal_strength, duration, data_size, … not yet in the switch).
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.NumericSensor,
        capabilities: ['numeric-sensor'],
      }
  }
}

// ── Binary sensor mapping (binary_sensor.*) ─────────────────────────────

function mapBinarySensor(deviceClass: string | null): HaEntityMapping {
  switch (deviceClass) {
    case 'motion':
    case 'occupancy':
    case 'presence':
    case 'moving':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.MotionSensor,
        capabilities: ['motion'],
      }
    case 'door':
    case 'window':
    case 'garage_door':
    case 'opening':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.ContactSensor,
        capabilities: ['contact'],
      }
    case 'moisture':
      return { deviceType: DeviceType.Sensor, role: DeviceRole.LeakSensor, capabilities: ['flood'] }
    case 'smoke':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.SmokeSensor,
        capabilities: ['smoke'],
      }
    case 'carbon_monoxide':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.COSensor,
        capabilities: ['carbon-monoxide'],
      }
    case 'gas':
      return { deviceType: DeviceType.Sensor, role: DeviceRole.GasSensor, capabilities: ['gas'] }
    case 'tamper':
    case 'safety':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.TamperSensor,
        capabilities: ['tamper'],
      }
    case 'vibration':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.VibrationSensor,
        capabilities: ['vibration'],
      }
    case 'connectivity':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.ConnectivitySensor,
        capabilities: ['connectivity'],
      }
    case 'sound':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.SoundSensor,
        capabilities: ['binary'],
      }
    case 'battery':
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.BatterySensor,
        capabilities: ['binary'],
      }
    default:
      // Generic binary sensor fallback.
      return {
        deviceType: DeviceType.Sensor,
        role: DeviceRole.BinarySensor,
        capabilities: ['binary'],
      }
  }
}

function readNumericAttr(attributes: Record<string, unknown>, key: string): number | null {
  const v = attributes[key]
  return typeof v === 'number' ? v : null
}

/**
 * Best-effort parent DeviceType inference from an HA device's entity
 * set. Picks the DeviceType of the entity with the most "weight" in
 * a stable order: actuator entities (switch / light / cover / lock /
 * fan / climate / media_player / alarm_control_panel) win over
 * sensor-only entities. Returns `DeviceType.Generic` when no entity
 * has a mapping.
 *
 * Used by the adoption flow to pick the parent's DeviceType so the
 * admin UI renders the right card layout (e.g. an Aqara Plug device
 * with switch + 3 sensors becomes a parent DeviceType.Switch, not
 * Sensor; an HA-tracked light with motion sensor becomes Light).
 */
const PARENT_TYPE_PRIORITY: readonly DeviceType[] = [
  DeviceType.MediaPlayer,
  DeviceType.AlarmPanel,
  DeviceType.Thermostat,
  // Air-conditioner shares the climate-control surface with Thermostat; same
  // precedence tier so an AC child wins over a container's auxiliary switches
  // (mirrors PRIORITY in ui-library primary-child.ts).
  DeviceType.Climate,
  // Humidifier / water heater are climate-family actuators; placed just after
  // Thermostat so a device owning both a thermostat and a humidifier prefers
  // Thermostat, while a humidifier-only / water-heater-only device infers its
  // own type.
  DeviceType.Humidifier,
  DeviceType.WaterHeater,
  DeviceType.Lock,
  DeviceType.Cover,
  // Valve is a cover-sibling actuator; placed just after Cover so a device
  // owning both prefers Cover, while a valve-only device infers Valve.
  DeviceType.Valve,
  DeviceType.Fan,
  DeviceType.Vacuum,
  DeviceType.LawnMower,
  DeviceType.Washer,
  DeviceType.Dryer,
  DeviceType.Dishwasher,
  DeviceType.Light,
  DeviceType.Switch,
  // Siren is a switch-family actuator — stronger than a fire-only Button.
  DeviceType.Siren,
  DeviceType.Button,
  DeviceType.Control,
  DeviceType.Notifier,
  DeviceType.Script,
  DeviceType.Automation,
  // A firmware-update entity is a weak parent signal, but a device owning ONLY
  // an `update.*` entity should still render as Update, not Generic.
  DeviceType.Update,
  DeviceType.Presence,
  // Weather / image are read-only display types — weak parent signals, but a
  // device owning ONLY a weather (or image) entity should still infer its own
  // type rather than Generic/Sensor. Weather precedes Image precedes Sensor.
  DeviceType.Weather,
  DeviceType.Image,
  DeviceType.Sensor,
]

export function inferParentDeviceType(
  mappings: readonly ({ deviceType: DeviceType } | null)[],
): DeviceType {
  const set = new Set<DeviceType>()
  for (const m of mappings) if (m) set.add(m.deviceType)
  for (const dt of PARENT_TYPE_PRIORITY) {
    if (set.has(dt)) return dt
  }
  return DeviceType.Generic
}
