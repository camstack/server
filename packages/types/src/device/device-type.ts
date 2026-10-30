export enum DeviceType {
  Camera = 'camera',
  Hub = 'hub',
  Light = 'light',
  Siren = 'siren',
  Switch = 'switch',
  Sensor = 'sensor',
  Thermostat = 'thermostat',
  /** Air-conditioner / heat-pump climate device (HVAC) — shares the
   *  `climate-control` cap surface with `Thermostat` but renders a
   *  dedicated AC-appropriate control UI (mode chips, fan speed,
   *  independent vertical/horizontal swing). Sources: native Gree, and
   *  reusable by other AC integrations. */
  Climate = 'climate',
  Button = 'button',
  /** Generic stateless event emitter — carries a device's EXACT declared
   *  event vocabulary verbatim (no normalization). Installed with the
   *  `event-emitter` cap. Sources: HA `event.*` entities (structured) and
   *  HA bus events (e.g. `zha_event`, generic). */
  EventEmitter = 'event-emitter',
  /** Firmware/software update entity — current vs available version,
   *  updatable flag, update state, and an install action. Installed with
   *  the `update` cap. Sources: Homematic firmware-update channels (and
   *  reusable by other providers, e.g. HA `update.*` entities). */
  Update = 'update',
  Generic = 'generic',

  // ── HA-targeted (also reusable for native integrations) ──────────────
  /** Generic notification delivery target (HA `notify.<service>`, future
   *  Telegram / Discord / ntfy / SMTP, …). One device per delivery
   *  endpoint; the `notifier` cap defines the send surface. */
  Notifier = 'notifier',
  /** Pre-recorded action sequence with optional parameters
   *  (HA `script.*`). Runnable via `script-runner` cap. */
  Script = 'script',
  /** Automation rule (HA `automation.*`) — enable/disable + manual
   *  trigger surface exposed via `automation-control` cap. */
  Automation = 'automation',
  /** Door / smart lock device (HA `lock.*`). `lock-control` cap. */
  Lock = 'lock',
  /** Window covering, blinds, garage door, valve, etc. (HA `cover.*`,
   *  `valve.*`). `cover` cap with sub-roles for variant. */
  Cover = 'cover',
  /** Pipe / water / gas valve with open/close/stop and optional
   *  position (HA `valve.*`). `valve` cap — a cover-sibling actuator
   *  modelled on the same open/closed lifecycle. */
  Valve = 'valve',
  /** Humidifier / dehumidifier with on/off + target humidity + mode
   *  (HA `humidifier.*`). `humidifier` cap — a climate-family actuator
   *  modelled on the same target / mode lifecycle. */
  Humidifier = 'humidifier',
  /** Water heater / boiler with target temperature + operation mode +
   *  away mode (HA `water_heater.*`). `water-heater` cap — a
   *  climate-family actuator. */
  WaterHeater = 'water-heater',
  /** Ceiling / standing / exhaust fan (HA `fan.*`). `fan-control` cap. */
  Fan = 'fan',
  /** Audio / video playback endpoint (HA `media_player.*`). Disjoint from
   *  the camera surface — those use `Camera`. `media-player` cap. */
  MediaPlayer = 'media-player',
  /** Security panel / alarm system (HA `alarm_control_panel.*`).
   *  `alarm-panel` cap. */
  AlarmPanel = 'alarm-panel',
  /** Generic user-settable input (HA `number` / `input_number` / `select`
   *  / `input_select` / `text` / `input_text` / `input_datetime`).
   *  Sub-type via `DeviceRole`: NumericControl / SelectControl /
   *  TextControl / DateTimeControl. */
  Control = 'control',
  /** Person / device-tracker presence (HA `person.*`, `device_tracker.*`).
   *  `presence` cap. */
  Presence = 'presence',
  /** Weather provider (HA `weather.*`). Tier-3, low MVP priority.
   *  `weather` cap. */
  Weather = 'weather',
  /** Robot vacuum (HA `vacuum.*`). Tier-3. `vacuum-control` cap. */
  Vacuum = 'vacuum',
  /** Robotic lawn mower (HA `lawn_mower.*`). Tier-3.
   *  `lawn-mower-control` cap. */
  LawnMower = 'lawn-mower',
  /** Physical HA device group — parent container for entity-children
   *  adopted from a single HA device entry. Not renderable as a
   *  standalone device; exists only to anchor child entities. */
  Container = 'container',
  /** Single still-image entity (HA `image.*`). Read-only display of an
   *  `entity_picture` signed URL the browser loads directly. `image` cap. */
  Image = 'image',
  /** Smart pet feeder — cloud-connected food dispenser with a bowl food
   *  level, battery, desiccant life, feeding state and manual-feed /
   *  call-pet / maintenance actions. Installed with the `pet-feeder` cap;
   *  dual-hopper models (D4S/D4SH) expose per-hopper portions. Sources:
   *  native PetKit (`nodepetkit` `FeederDevice`), reusable by other feeder
   *  integrations sharing the same food/desiccant/hopper surface. */
  PetFeeder = 'pet-feeder',
  /** Pet water fountain — tank level, water drunk, pump and its duty cycle.
   *  Installed with the `pet-fountain` cap. Reaches CamStack as loose entities
   *  of a container and is BUILT as a composed device (D967). */
  PetFountain = 'pet-fountain',
  /** Built-in dishwasher — program lifecycle, door / remote-start gates,
   *  salt and rinse-aid levels. Installed with the `dishwasher` cap.
   *  Sources: native Bosch Home Connect, reusable by similar integrations.
   *  A plug-built dishwasher carries running-state and power instead. */
  Dishwasher = 'dishwasher',
  /** Washing machine. A plug-built one is running while its power stays
   *  above a threshold. No program cap — that surface is the dishwasher's. */
  Washer = 'washer',
  /** Tumble dryer. Same plug-built running surface as {@link Washer}. */
  Dryer = 'dryer',
  /** The physical bridge box of a vendor ecosystem (Velux KLF-200, and later
   *  other radio-to-IP bridges). It carries the box's own facts (firmware,
   *  address, connection state) and the actions the box really supports
   *  (`reboot`, `device-admin-link`). Products are NOT its children — they are
   *  adopted beside it — and its connection settings stay on the integration. */
  Gateway = 'gateway',
}

export enum DeviceFeature {
  BatteryOperated = 'battery-operated',
  Rebootable = 'rebootable',
  /**
   * Device supports an on-demand re-sync of its derived spec with its
   * upstream source — drives the generic Re-sync button. The owning
   * provider implements the action via the `device-adoption.resync` cap.
   */
  Resyncable = 'resyncable',
  NativeSnapshot = 'native-snapshot',
  DoorbellButton = 'doorbell-button',
  TwoWayAudio = 'two-way-audio',
  PanTiltZoom = 'pan-tilt-zoom',
  /**
   * Camera supports the on-firmware autotrack subsystem (subject-
   * following). Distinct from `PanTiltZoom` because not every PTZ
   * camera ships autotrack — the admin UI uses this flag to gate
   * the autotrack toggle / settings card without re-deriving from
   * the cap registry. Mirrors `ptz-autotrack` cap registration:
   * driver sets this feature when probe confirms the firmware
   * surface, and registers the cap in the same code path.
   */
  PtzAutotrack = 'ptz-autotrack',
  /**
   * Accessory exposes a "trigger on motion" toggle — the parent camera's
   * motion detection automatically activates this device. Mirrors
   * `motion-trigger` cap registration: drivers set this feature in the
   * same code path that calls `ctx.registerNativeCap(motionTriggerCapability, ...)`.
   *
   * Used by admin UI (gate the in-hero `MotionTriggerToggle` against a
   * fast scalar without binding fetch), notifier rules, and `listAll`
   * filters that want "all devices with on-motion behaviour".
   */
  MotionTrigger = 'motion-trigger',

  // ── HA-targeted actuator sub-features (Phase C1 retroactive) ────────
  // Granular color-mode support — paired with `colorCapability`. A
  // bulb that supports multiple color modes sets all the corresponding
  // flags; a CCT-only tunable-white bulb sets only `LightColorMired`.

  /** Light supports rgb-triplet color via `color` cap. */
  LightColorRgb = 'light-color-rgb',
  /** Light supports HSV color via `color` cap. */
  LightColorHsv = 'light-color-hsv',
  /** Light supports color-temperature (mired) via `color` cap. */
  LightColorMired = 'light-color-mired',

  // Climate sub-surface gating — paired with `climateControlCapability`.

  /** Thermostat supports a `heat_cool` dual setpoint (targetLow +
   *  targetHigh). Gates the range slider UI. */
  ClimateDualSetpoint = 'climate-dual-setpoint',
  /** Thermostat exposes target humidity and/or current humidity
   *  readings. Gates the humidity controls. */
  ClimateHumidity = 'climate-humidity',
  /** Thermostat exposes a fan-mode selector. */
  ClimateFanMode = 'climate-fan-mode',
  /** Thermostat exposes preset modes (eco / away / sleep / vendor). */
  ClimatePreset = 'climate-preset',
  /** Thermostat exposes a vertical louver swing toggle. Gates the
   *  vertical-swing switch in the climate UI. Independent of horizontal. */
  ClimateSwingVertical = 'climate-swing-vertical',
  /** Thermostat exposes a horizontal louver swing toggle. Gates the
   *  horizontal-swing switch in the climate UI. Independent of vertical. */
  ClimateSwingHorizontal = 'climate-swing-horizontal',

  // ── HA-targeted actuator sub-features (Phase C2 retroactive) ────────

  /** Cover exposes intermediate position control (0..100). Gates the
   *  position slider UI. */
  CoverPositionable = 'cover-positionable',
  /** Cover exposes slat-tilt control. Gates the tilt slider UI. */
  CoverTilt = 'cover-tilt',
  /** Valve exposes intermediate position control (0..100). Gates the
   *  position slider / drag surface UI. */
  ValvePositionable = 'valve-positionable',
  /** Fan exposes a speed-percentage setter. Gates the speed slider UI. */
  FanSpeed = 'fan-speed',
  /** Fan exposes a preset mode selector. */
  FanPreset = 'fan-preset',
  /** Fan exposes blade direction (forward/reverse) — typical of
   *  ceiling fans. */
  FanDirection = 'fan-direction',
  /** Fan exposes an oscillation toggle. */
  FanOscillating = 'fan-oscillating',
  /** Lock requires a PIN code on lock/unlock. Gates the code-entry
   *  field on the UI lock-controls panel. */
  LockPinRequired = 'lock-pin-required',
  /** Lock supports a latch-release ("open door") action distinct from
   *  unlock. Mirrors HA `LockEntityFeature.OPEN` (bit 1) in
   *  `supported_features`. Gates the Open Door button in the UI. */
  LockOpen = 'lock-open',

  // ── HA-targeted actuator sub-features (Phase C3) ─────────────────────
  // Mirrors the pattern of `PanTiltZoom` / `PtzAutotrack`: each flag pairs
  // with a capability registration but gates a sub-control inside the
  // device's UI without requiring a binding fetch. Drivers set the flag
  // in the same code path that registers the cap when probe confirms the
  // sub-surface (e.g. HA reports `supported_features & SUPPORT_SEEK`).

  /** Media player exposes a seek-to-position surface. */
  MediaPlayerSeek = 'media-player-seek',
  /** Media player exposes a volume-level setter. */
  MediaPlayerVolume = 'media-player-volume',
  /** Media player exposes a mute toggle distinct from volume=0. */
  MediaPlayerMute = 'media-player-mute',
  /** Media player exposes a shuffle toggle. */
  MediaPlayerShuffle = 'media-player-shuffle',
  /** Media player exposes a repeat mode (off / all / one). */
  MediaPlayerRepeat = 'media-player-repeat',
  /** Media player exposes a source / input selector. */
  MediaPlayerSelectSource = 'media-player-select-source',
  /** Media player exposes a play-arbitrary-media surface (URL / id). */
  MediaPlayerPlayMedia = 'media-player-play-media',
  /** Media player exposes next-track. */
  MediaPlayerNext = 'media-player-next',
  /** Media player exposes previous-track. */
  MediaPlayerPrevious = 'media-player-previous',
  /** Media player exposes stop distinct from pause. */
  MediaPlayerStop = 'media-player-stop',
  /** Alarm panel requires a PIN code on arm/disarm. */
  AlarmPinRequired = 'alarm-pin-required',
  /** Presence device carries GPS coordinates (lat/lng/accuracy) in
   *  addition to a textual location. */
  PresenceGps = 'presence-gps',
  /** Notifier accepts an inline / URL image attachment. */
  NotifierImage = 'notifier-image',
  /** Notifier accepts a priority hint (high/normal/low). */
  NotifierPriority = 'notifier-priority',
  /** Notifier accepts a free-form `data` payload for platform-specific
   *  fields. */
  NotifierData = 'notifier-data',
  /** Notifier supports interactive action buttons / callbacks. */
  NotifierActions = 'notifier-actions',
  /** Notifier supports per-call recipient targeting (multi-user). */
  NotifierRecipients = 'notifier-recipients',
  /** Script runner accepts a variables map on each run invocation. */
  ScriptVariables = 'script-variables',
  /** Automation `trigger` accepts a skipCondition flag — fires the
   *  automation's actions while bypassing its condition block. */
  AutomationSkipCondition = 'automation-skip-condition',

  // ── Robot vacuum / mower sub-features (Dreame) ───────────────────────
  // Mirror the PanTiltZoom / PtzAutotrack pattern: the provider sets the
  // flag in the SAME probe code path that decides whether to spawn the
  // corresponding child entities, so the admin UI gates the hero map /
  // AI / mow controls against a fast scalar without iterating children.
  // Set ONLY when probe confirms the surface (never optimistically).

  /** Robot vacuum exposes a live cleaning map (image child). Gates the
   *  map tile in the vacuum UI. */
  VacuumHasMap = 'vacuum-has-map',
  /** Robot vacuum exposes AI obstacle-detection toggles. Gates the AI
   *  switches group. */
  VacuumHasAi = 'vacuum-has-ai',
  /** Robot mower exposes a live mowing map (SVG image child). Gates the
   *  mower map tile. */
  MowerHasMap = 'mower-has-map',
  /** Robot mower exposes targeted mowing (all-area / zones / edges /
   *  spots) — gates the Mow action + map selectors. */
  MowerHasTargetedMowing = 'mower-has-targeted-mowing',
}

export enum ChargingStatus {
  ChargingDC = 'charging-dc',
  ChargingSolar = 'charging-solar',
  NotCharging = 'not-charging',
}

/**
 * Semantic role a device plays within its parent. Populated by driver
 * addons when creating accessory devices (Reolink siren/floodlight/
 * PIR/chime/autotrack/doorbell, ONVIF relay outputs, …). Used by the
 * admin UI to pick icons, labels, and widgets — a `Switch` with
 * `role: Floodlight` renders as a bulb with a brightness slider,
 * whereas a `Switch` with `role: Siren` renders as a klaxon.
 *
 * Undefined for top-level devices (cameras, NVRs, hubs). Persisted in
 * sqlite as a nullable TEXT column — old rows keep working unchanged.
 */
export enum DeviceRole {
  // ── Switch-type accessories (camera-driven) ──────────────
  Siren = 'siren',
  Floodlight = 'floodlight',
  Spotlight = 'spotlight',
  PirSensor = 'pir-sensor',
  Chime = 'chime',
  Autotrack = 'autotrack',
  Nightvision = 'nightvision',
  PrivacyMask = 'privacy-mask',

  // ── Button-type accessories ──────────────────────────────
  Doorbell = 'doorbell',

  // ── Cover sub-roles (the KIND of a `cover` device) ───────
  /** Interior blind / shade / roller blind. HA `device_class: blind|shade`. */
  CoverBlind = 'cover-blind',
  /** Exterior roller shutter. HA `device_class: shutter`; Homematic BROLL. */
  CoverShutter = 'cover-shutter',
  /** Exterior awning. HA `device_class: awning`. */
  CoverAwning = 'cover-awning',
  /** Curtain / drape. HA `device_class: curtain`. */
  CoverCurtain = 'cover-curtain',
  /** Garage door. HA `device_class: garage`. A security actuator: exports gate it. */
  CoverGarage = 'cover-garage',
  /** Gate. HA `device_class: gate`. A security actuator: exports gate it. */
  CoverGate = 'cover-gate',
  /** Door. HA `device_class: door`. A security actuator: exports gate it. */
  CoverDoor = 'cover-door',
  /** Window. HA `device_class: window`. */
  CoverWindow = 'cover-window',

  // ── Switch sub-roles (HA-driven) ─────────────────────────
  /** Virtual HA toggle (input_boolean.*) — distinguishable from a
   *  real Switch device for UI rendering / export adapters. */
  BinaryHelper = 'binary-helper',
  /** A smart plug: a `switch` whose source says it is an outlet (HA
   *  `device_class: outlet`). The Alexa export shows it as a SMARTPLUG. */
  Outlet = 'outlet',

  // ── Sensor sub-roles — binary_sensor family ──────────────
  /** Generic motion / occupancy / moving event source. Distinct from
   *  the camera accessory PirSensor role: that one is a camera child;
   *  this is a standalone HA / 3rd-party motion sensor. */
  MotionSensor = 'motion-sensor',
  ContactSensor = 'contact-sensor',
  LeakSensor = 'leak-sensor',
  SmokeSensor = 'smoke-sensor',
  COSensor = 'co-sensor',
  GasSensor = 'gas-sensor',
  TamperSensor = 'tamper-sensor',
  VibrationSensor = 'vibration-sensor',
  ConnectivitySensor = 'connectivity-sensor',
  SoundSensor = 'sound-sensor',
  /** Fallback for `binary_sensor` without a known `device_class`. */
  BinarySensor = 'binary-sensor',

  // ── Sensor sub-roles — numeric ───────────────────────────
  TemperatureSensor = 'temperature-sensor',
  HumiditySensor = 'humidity-sensor',
  AmbientLightSensor = 'ambient-light-sensor',
  PressureSensor = 'pressure-sensor',
  /** Wind speed or direction (weather-station `wind-sensor` cap). */
  WindSensor = 'wind-sensor',
  /** Rain accumulation or rate (weather-station `rain-sensor` cap). */
  RainSensor = 'rain-sensor',
  /** UV index (weather-station `uv-sensor` cap). */
  UvSensor = 'uv-sensor',
  /** Solar irradiance W/m² (weather-station `solar-radiation-sensor` cap).
   *  Distinct from AmbientLightSensor (lux). */
  SolarRadiationSensor = 'solar-radiation-sensor',
  /** Soil moisture % (garden/weather `soil-moisture-sensor` cap). */
  SoilMoistureSensor = 'soil-moisture-sensor',
  PowerSensor = 'power-sensor',
  EnergySensor = 'energy-sensor',
  VoltageSensor = 'voltage-sensor',
  CurrentSensor = 'current-sensor',
  AirQualitySensor = 'air-quality-sensor',
  /** Battery level (numeric % via `sensor` OR low-bool via
   *  `binary_sensor` — the cap distinguishes via the value type). */
  BatterySensor = 'battery-sensor',
  /** Fallback for `sensor` numeric without a known `device_class`. */
  NumericSensor = 'numeric-sensor',
  /** String / enum state (HA `sensor` with `state_class: enum` or
   *  `attributes.options`). */
  EnumSensor = 'enum-sensor',
  /** Date / timestamp state (HA `sensor` with `device_class: timestamp`
   *  or `date`). The slice carries the raw ISO string verbatim (hosted on
   *  the `enum-sensor` cap); the UI renders it locale-formatted. */
  DateTimeSensor = 'datetime-sensor',
  /** Last-resort fallback when nothing else matches. */
  GenericSensor = 'generic-sensor',

  // ── Control sub-roles (input setters) ────────────────────
  NumericControl = 'numeric-control',
  SelectControl = 'select-control',
  TextControl = 'text-control',
  DateTimeControl = 'datetime-control',

  // ── Notifier sub-roles ───────────────────────────────────
  /** Mobile push notifier (HA `notify.mobile_app_*`) — supports
   *  rich features (image, priority, channel routing). */
  MobilePushNotifier = 'mobile-push-notifier',
  /** Chat / messaging service (HA `notify.telegram_*`,
   *  `notify.discord_*`, etc.). */
  MessagingNotifier = 'messaging-notifier',
  /** Email-based delivery (HA `notify.smtp`, etc.). */
  EmailNotifier = 'email-notifier',
  /** Fallback when the notifier service name doesn't match a known
   *  pattern. */
  GenericNotifier = 'generic-notifier',

  // ── Generic-type sub-roles ───────────────────────────────
  /** Emits a pulse train (infrared or RF) on request — the `ir-transmitter`
   *  cap. A `DeviceType.Generic` device. */
  IrTransmitter = 'ir-transmitter',
}
