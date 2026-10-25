import {
  type AutoSwitchKey,
  ChargingStatus,
  MiotError,
  type MiotProp,
  MowerChargingStatus,
  MowerFault,
  MowerStatus,
  MowerTaskStatus,
} from '@apocaliss92/nodedreame'

/**
 * Data-driven Dreame entity catalog. Rather than a class per entity, each
 * non-core Dreame entity is described once here (its MIoT coordinates + how to
 * present it) and a generic typed child renders it. The catalog is the SINGLE
 * place to grow coverage toward HA's full entity set; the container spawns a
 * child per descriptor ONLY when the device REPORTS the property (presence-driven
 * — see `dreame-container-device.ts`), so a model never shows an entity it lacks.
 *
 * Coordinates ported from the Tasshack `dreame-vacuum` HA integration
 * (v2.0.0b25) MIoT property map. Sections drive the container `childLayout`.
 */

/** A read-only numeric sensor (value + display unit). */
export interface NumericSensorDescriptor {
  /** Stable child key (also the childLayout `childKey` suffix). */
  readonly key: string
  /** Display name. */
  readonly label: string
  /** MIoT service / property id of the value. */
  readonly siid: number
  readonly piid: number
  /** Display unit (e.g. 'min', 'h', 'days', 'm²', '%', 'times'). */
  readonly unit?: string
  /** Accordion section for the container `childLayout`. */
  readonly section: string
}

const STATS = 'Statistics'
const MAINT = 'Maintenance'

/**
 * Read-only numeric sensors. Consumable remaining-LIFE %s and battery are
 * intentionally omitted (already surfaced by the `consumables` / `vacuum-control`
 * caps); these are the cleaning statistics + per-consumable "time until
 * replacement" durations that add NEW information.
 */
export const DREAME_NUMERIC_SENSORS: readonly NumericSensorDescriptor[] = [
  // Cleaning statistics
  { key: 'cleaning-time', label: 'Cleaning Time', siid: 4, piid: 2, unit: 'min', section: STATS },
  { key: 'cleaned-area', label: 'Cleaned Area', siid: 4, piid: 3, unit: 'm²', section: STATS },
  {
    key: 'cleaning-progress',
    label: 'Cleaning Progress',
    siid: 4,
    piid: 63,
    unit: '%',
    section: STATS,
  },
  {
    key: 'drying-progress',
    label: 'Drying Progress',
    siid: 4,
    piid: 64,
    unit: '%',
    section: STATS,
  },
  {
    key: 'total-cleaning-time',
    label: 'Total Cleaning Time',
    siid: 12,
    piid: 2,
    unit: 'min',
    section: STATS,
  },
  {
    key: 'cleaning-count',
    label: 'Cleaning Count',
    siid: 12,
    piid: 3,
    unit: 'times',
    section: STATS,
  },
  {
    key: 'total-cleaned-area',
    label: 'Total Cleaned Area',
    siid: 12,
    piid: 4,
    unit: 'm²',
    section: STATS,
  },
  // Time-until-replacement durations (the % life lives on the consumables cap)
  {
    key: 'main-brush-time-left',
    label: 'Main Brush Time Left',
    siid: 9,
    piid: 1,
    unit: 'h',
    section: MAINT,
  },
  {
    key: 'side-brush-time-left',
    label: 'Side Brush Time Left',
    siid: 10,
    piid: 1,
    unit: 'h',
    section: MAINT,
  },
  {
    key: 'filter-time-left',
    label: 'Filter Time Left',
    siid: 11,
    piid: 2,
    unit: 'h',
    section: MAINT,
  },
  {
    key: 'sensor-time-left',
    label: 'Sensor Time Left',
    siid: 16,
    piid: 2,
    unit: 'h',
    section: MAINT,
  },
  {
    key: 'tank-filter-time-left',
    label: 'Tank Filter Time Left',
    siid: 17,
    piid: 2,
    unit: 'h',
    section: MAINT,
  },
  {
    key: 'mop-pad-time-left',
    label: 'Mop Pad Time Left',
    siid: 18,
    piid: 2,
    unit: 'h',
    section: MAINT,
  },
  {
    key: 'silver-ion-time-left',
    label: 'Silver-ion Time Left',
    siid: 19,
    piid: 1,
    unit: 'days',
    section: MAINT,
  },
  {
    key: 'detergent-time-left',
    label: 'Detergent Time Left',
    siid: 20,
    piid: 2,
    unit: 'days',
    section: MAINT,
  },
  {
    key: 'squeegee-time-left',
    label: 'Squeegee Time Left',
    siid: 24,
    piid: 2,
    unit: 'days',
    section: MAINT,
  },
  {
    key: 'deodorizer-time-left',
    label: 'Deodorizer Time Left',
    siid: 29,
    piid: 1,
    unit: 'days',
    section: MAINT,
  },
  {
    key: 'wheel-time-left',
    label: 'Wheel Time Left',
    siid: 30,
    piid: 1,
    unit: 'days',
    section: MAINT,
  },
  {
    key: 'scale-inhibitor-time-left',
    label: 'Scale Inhibitor Time Left',
    siid: 31,
    piid: 1,
    unit: 'days',
    section: MAINT,
  },
]

/** A writable boolean switch backed by ONE direct MIoT property (value 0/1). */
export interface SwitchDescriptor {
  readonly key: string
  readonly label: string
  readonly siid: number
  readonly piid: number
  readonly section: string
}

const S_CLEAN = 'Cleaning'
const S_CARPET = 'Carpet'
const S_STATION = 'Station & Mop'
const S_DND = 'Do Not Disturb'
const S_GENERAL = 'General'

/**
 * Direct-property boolean switches (Tasshack `DreameVacuumProperty` switch
 * platform — value 0/1, written verbatim). The packed `AutoSwitchProperty` /
 * AI families are handled separately (AI switches ship; auto_switch is a future
 * codec slice). Presence-driven: only those the model reports are spawned.
 */
export const DREAME_SWITCHES: readonly SwitchDescriptor[] = [
  // Cleaning behaviour
  { key: 'resume-cleaning', label: 'Resume Cleaning', siid: 4, piid: 11, section: S_CLEAN },
  { key: 'obstacle-avoidance', label: 'Obstacle Avoidance', siid: 4, piid: 21, section: S_CLEAN },
  { key: 'customized-cleaning', label: 'Customized Cleaning', siid: 4, piid: 26, section: S_CLEAN },
  { key: 'tight-mopping', label: 'Tight Mopping', siid: 4, piid: 29, section: S_CLEAN },
  {
    key: 'intelligent-recognition',
    label: 'Intelligent Recognition',
    siid: 4,
    piid: 49,
    section: S_CLEAN,
  },
  {
    key: 'dynamic-obstacle-cleaning',
    label: 'Dynamic Obstacle Cleaning',
    siid: 28,
    piid: 18,
    section: S_CLEAN,
  },
  {
    key: 'pressurized-cleaning',
    label: 'Pressurized Cleaning',
    siid: 28,
    piid: 53,
    section: S_CLEAN,
  },
  {
    key: 'obstacle-crossing',
    label: 'Synchronized Obstacle Crossing',
    siid: 28,
    piid: 38,
    section: S_CLEAN,
  },
  {
    key: 'active-suspension-crossing',
    label: 'Active Suspension Crossing',
    siid: 28,
    piid: 84,
    section: S_CLEAN,
  },
  // Carpet
  { key: 'carpet-boost', label: 'Carpet Boost', siid: 4, piid: 12, section: S_CARPET },
  { key: 'carpet-recognition', label: 'Carpet Recognition', siid: 4, piid: 33, section: S_CARPET },
  {
    key: 'clean-carpets-first',
    label: 'Clean Carpets First',
    siid: 28,
    piid: 2,
    section: S_CARPET,
  },
  {
    key: 'side-brush-carpet-rotate',
    label: 'Side Brush Carpet Rotate',
    siid: 28,
    piid: 29,
    section: S_CARPET,
  },
  {
    key: 'lift-chassis-on-carpet',
    label: 'Lift Chassis On Carpet',
    siid: 28,
    piid: 60,
    section: S_CARPET,
  },
  {
    key: 'close-roller-cover-on-carpet',
    label: 'Close Roller Cover On Carpet',
    siid: 28,
    piid: 69,
    section: S_CARPET,
  },
  // Station & mop
  {
    key: 'auto-dust-collecting',
    label: 'Auto Dust Collecting',
    siid: 15,
    piid: 1,
    section: S_STATION,
  },
  { key: 'self-clean', label: 'Self Clean', siid: 4, piid: 34, section: S_STATION },
  { key: 'water-electrolysis', label: 'Water Electrolysis', siid: 4, piid: 32, section: S_STATION },
  {
    key: 'auto-water-refilling',
    label: 'Auto Water Refilling',
    siid: 4,
    piid: 51,
    section: S_STATION,
  },
  { key: 'auto-add-detergent', label: 'Auto Add Detergent', siid: 4, piid: 37, section: S_STATION },
  {
    key: 'mopping-with-detergent',
    label: 'Mopping With Detergent',
    siid: 28,
    piid: 52,
    section: S_STATION,
  },
  { key: 'auto-mount-mop', label: 'Auto Mount Mop', siid: 4, piid: 45, section: S_STATION },
  { key: 'auto-change-mop', label: 'Auto Change Mop', siid: 28, piid: 62, section: S_STATION },
  { key: 'smart-mop-washing', label: 'Smart Mop Washing', siid: 28, piid: 22, section: S_STATION },
  { key: 'silent-drying', label: 'Silent Drying', siid: 28, piid: 27, section: S_STATION },
  { key: 'dust-bag-drying', label: 'Dust Bag Drying', siid: 28, piid: 48, section: S_STATION },
  { key: 'hair-compression', label: 'Hair Compression', siid: 28, piid: 28, section: S_STATION },
  // Do Not Disturb
  {
    key: 'dnd-disable-resume-cleaning',
    label: 'DND Disable Resume Cleaning',
    siid: 28,
    piid: 14,
    section: S_DND,
  },
  {
    key: 'dnd-disable-auto-empty',
    label: 'DND Disable Auto Empty',
    siid: 28,
    piid: 15,
    section: S_DND,
  },
  { key: 'dnd-reduce-volume', label: 'DND Reduce Volume', siid: 28, piid: 16, section: S_DND },
  // General
  { key: 'child-lock', label: 'Child Lock', siid: 4, piid: 27, section: S_GENERAL },
  { key: 'voice-assistant', label: 'Voice Assistant', siid: 7, piid: 5, section: S_GENERAL },
  { key: 'off-peak-charging', label: 'Off-Peak Charging', siid: 3, piid: 3, section: S_GENERAL },
  {
    key: 'ring-light-always-on',
    label: 'Ring Light Always On',
    siid: 28,
    piid: 61,
    section: S_GENERAL,
  },
  { key: 'multi-floor-map', label: 'Multi-Floor Map', siid: 6, piid: 7, section: S_GENERAL },
  { key: 'map-saving', label: 'Map Saving', siid: 13, piid: 1, section: S_GENERAL },
  { key: 'lds-state', label: 'LiDAR Navigation', siid: 28, piid: 4, section: S_GENERAL },
]

/** One choice of a {@link SelectDescriptor}: the raw MIoT int + its label. */
export interface SelectOption {
  /** MIoT property value written/read for this choice. */
  readonly value: number
  /** Display label shown in the dropdown. */
  readonly label: string
}

/**
 * A writable enum exposed as a `DeviceType.Control` (`select-control` role)
 * child, backed by ONE direct MIoT property holding an int. The int↔label map
 * comes from nodedreame's VERIFIED vacuum enums (the MIoT authority) — only the
 * safe, plain-int write paths are listed (e.g. clean-mode uses CLEAN_MODE_SETTING
 * siid 2 piid 6, NOT the packed CLEANING_MODE siid 4 piid 23). The packed
 * `AutoSwitchProperty` selects are a future codec slice.
 */
export interface SelectDescriptor {
  readonly key: string
  readonly label: string
  readonly siid: number
  readonly piid: number
  readonly options: readonly SelectOption[]
  readonly section: string
}

/**
 * Direct-property selects (writable enums). Coordinates + int→label maps ported
 * from nodedreame `models/vacuum/{properties,enums}.ts` — the VERIFIED safe-write
 * subset. Presence-driven: spawned only when the model reports the property.
 *
 * NOTE — `cleaning-mode` (CLEAN_MODE_SETTING siid 2 piid 6) is intentionally
 * NOT listed yet: nodedreame's `CleaningMode` enum is verified for 0..3 only, but
 * r2538z reports value 4 live (unmapped). Re-add it here once nodedreame's
 * `CleaningMode` enum covers the newer-model values so every spawned select reads
 * an authoritative label rather than blank. The raw CLEANING_MODE (siid 4 piid 23)
 * is a capability-masked bitfield — never write it.
 */
export const DREAME_SELECTS: readonly SelectDescriptor[] = [
  {
    key: 'suction-level',
    label: 'Suction Level',
    siid: 4,
    piid: 4,
    options: [
      { value: 0, label: 'Quiet' },
      { value: 1, label: 'Standard' },
      { value: 2, label: 'Intense' },
      { value: 3, label: 'Max' },
    ],
    section: S_CLEAN,
  },
  {
    key: 'water-volume',
    label: 'Water Volume',
    siid: 4,
    piid: 5,
    options: [
      { value: 1, label: 'Low' },
      { value: 2, label: 'Medium' },
      { value: 3, label: 'High' },
    ],
    section: S_CLEAN,
  },
  // Carpet handling — int→label maps from Tasshack `DreameVacuumCarpetSensitivity`
  // / `DreameVacuumCarpetCleaning`. carpet-cleaning value 2 = 'Adaptation' was
  // cross-validated against HA (select.*_carpet_cleaning = adaptation).
  {
    key: 'carpet-sensitivity',
    label: 'Carpet Sensitivity',
    siid: 4,
    piid: 28,
    options: [
      { value: 1, label: 'Low' },
      { value: 2, label: 'Medium' },
      { value: 3, label: 'High' },
    ],
    section: S_CARPET,
  },
  {
    key: 'carpet-cleaning',
    label: 'Carpet Cleaning',
    siid: 4,
    piid: 36,
    options: [
      { value: 0, label: 'Not Set' },
      { value: 1, label: 'Avoidance' },
      { value: 2, label: 'Adaptation' },
      { value: 3, label: 'Remove Mop' },
      { value: 4, label: 'Adaptation Without Route' },
      { value: 5, label: 'Vacuum And Mop' },
      { value: 6, label: 'Ignore' },
      { value: 7, label: 'Cross' },
    ],
    section: S_CARPET,
  },
  // Station / mop — Tasshack `DreameVacuumMopWashLevel` / `DreameVacuumCleanGeniusMode`.
  {
    key: 'mop-wash-level',
    label: 'Mop Wash Level',
    siid: 4,
    piid: 46,
    options: [
      { value: 0, label: 'Water Saving' },
      { value: 1, label: 'Daily' },
      { value: 2, label: 'Deep' },
    ],
    section: S_STATION,
  },
  {
    key: 'cleangenius-mode',
    label: 'CleanGenius Mode',
    siid: 28,
    piid: 5,
    options: [
      { value: 2, label: 'Vacuum And Mop' },
      { value: 3, label: 'Mop After Vacuum' },
    ],
    section: S_STATION,
  },
]

/**
 * A fire-only MIoT action exposed as a `DeviceType.Button` child (`callAction`).
 * Actions have no readable state, so presence is derived from an OPTIONAL
 * companion property (`presenceSiid`/`presencePiid`): a station action is shown
 * only when the model reports its station capability. Actions without a presence
 * prop are universal (every vacuum supports locate / clear-warning).
 */
export interface ButtonDescriptor {
  readonly key: string
  readonly label: string
  readonly siid: number
  readonly aiid: number
  readonly section: string
  /** Companion property whose presence gates the button. Omit for universal
   *  actions (always spawned). */
  readonly presenceSiid?: number
  readonly presencePiid?: number
}

/**
 * Fire-only action buttons (Tasshack button platform / nodedreame VACUUM_ACTION).
 * The start/pause/charge/stop verbs already live on the `vacuum-control` cap;
 * these add the NEW standalone affordances HA exposes as buttons. Station actions
 * carry a presence prop so they only show on docks that support them.
 */
export const DREAME_BUTTONS: readonly ButtonDescriptor[] = [
  // Universal robot actions — every vacuum supports these.
  { key: 'locate', label: 'Locate', siid: 7, aiid: 1, section: S_GENERAL },
  { key: 'clear-warning', label: 'Clear Warning', siid: 4, aiid: 3, section: S_GENERAL },
  // Station actions — gated on the dock capability the model reports.
  {
    key: 'empty-dustbin',
    label: 'Empty Dustbin',
    siid: 15,
    aiid: 1,
    section: S_STATION,
    // Auto-empty dock → reports AUTO_DUST_COLLECTING (siid 15 piid 1).
    presenceSiid: 15,
    presencePiid: 1,
  },
  {
    key: 'start-washing',
    label: 'Start Mop Washing',
    siid: 4,
    aiid: 4,
    section: S_STATION,
    // Mop-wash dock → reports SELF_CLEAN (siid 4 piid 34).
    presenceSiid: 4,
    presencePiid: 34,
  },
  // NOTE: consumable RESETs are intentionally NOT buttons here — the `consumables`
  // cap already exposes a per-item reset (live-verified: main-brush/side-brush/
  // filter/sensor/wheel/scale-inhibitor all report resettable:true via
  // nodedreame VACUUM_CONSUMABLES). Separate reset buttons would be redundant.
]

/**
 * A read-only enum-state sensor (an int MIoT property rendered as a label).
 * The int→label `options` come from nodedreame's VERIFIED vacuum enums — the
 * authoritative map. An int not in the map surfaces as its raw string (read-only,
 * so a raw fallback is informative rather than dangerous — cf. selects, where an
 * unmapped value is left blank because writing the wrong int is unsafe).
 */
export interface EnumSensorDescriptor {
  readonly key: string
  readonly label: string
  readonly siid: number
  readonly piid: number
  readonly options: readonly SelectOption[]
  readonly section: string
}

const DIAG = 'Diagnostics'

/** Humanise a PascalCase enum member name → spaced Title Case
 *  ('InterruptedOrPaused' → 'Interrupted Or Paused'). */
function humanizeEnumName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

/** Build `{ value, label }` options from a numeric TS enum (forward entries only —
 *  numeric enums also carry reverse `value→name` keys, filtered out here). */
function enumOptions(e: Record<string, string | number>): readonly SelectOption[] {
  return Object.entries(e)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([name, value]) => ({ value, label: humanizeEnumName(name) }))
}

/**
 * MiotError codes that are BENIGN completion / reminder states, not active
 * faults. HA does not surface these as errors — a fresh cloud-shadow read of an
 * idle docked robot legitimately returns `TaskComplete` (68). We relabel them to
 * the `Clear` label so the Error sensor only shows real faults (HA parity).
 * Extend this set if other non-fault codes surface as spurious "errors".
 */
const BENIGN_ERROR_CODES: ReadonlySet<number> = new Set<number>([MiotError.TaskComplete])

/** `MiotError` options with the benign completion codes remapped to the `Clear`
 *  label, so the Error sensor reads as no-error for them (matches HA). */
function errorEnumOptions(): readonly SelectOption[] {
  const clearLabel = humanizeEnumName(MiotError[MiotError.Clear])
  return enumOptions(MiotError).map((o) =>
    BENIGN_ERROR_CODES.has(o.value) ? { ...o, label: clearLabel } : o,
  )
}

/**
 * Resolve the CURRENT catalog options for an enum-sensor by its MIoT coordinates
 * (across both the vacuum and mower enum-sensor catalogs). The enum-sensor child
 * persists its option map at adoption; preferring the live catalog here lets a
 * label change (e.g. the benign-error remap) take effect for already-adopted
 * children on the next boot — without a re-adopt. Null when no catalog entry
 * matches (persisted config is then the only source).
 */
export function enumSensorOptionsFor(siid: number, piid: number): readonly SelectOption[] | null {
  const hit = [...DREAME_ENUM_SENSORS, ...DREAME_MOWER_ENUM_SENSORS].find(
    (es) => es.siid === siid && es.piid === piid,
  )
  return hit?.options ?? null
}

/** Humanise a Tasshack SNAKE_CASE enum name → spaced Title Case
 *  ('BACK_HOME' → 'Back Home'). */
function humanizeSnake(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ')
}

/** Build options from a Tasshack `[value, SNAKE_NAME]` map. */
function tupleOptions(pairs: ReadonlyArray<readonly [number, string]>): readonly SelectOption[] {
  return pairs.map(([value, name]) => ({ value, label: humanizeSnake(name) }))
}

/**
 * `DreameVacuumStatus` (STATUS, siid 4 piid 1) — the robot's high-level status.
 * Ported from Tasshack `types.py`. nodedreame mislabels 4/1 as "TaskStatus"; the
 * live device + HA confirm 4/1 is STATUS (value 14 = Sleeping) and 4/7 is the real
 * TASK_STATUS — so this map (and the 4/7 one below) come from Tasshack, the
 * authority for these two props.
 */
const TS_STATUS: ReadonlyArray<readonly [number, string]> = [
  [0, 'IDLE'],
  [1, 'PAUSED'],
  [2, 'CLEANING'],
  [3, 'BACK_HOME'],
  [4, 'PARTIAL_CLEANING'],
  [5, 'FOLLOW_WALL'],
  [6, 'CHARGING'],
  [7, 'OTA'],
  [8, 'FCT'],
  [9, 'WIFI_SET'],
  [10, 'POWER_OFF'],
  [11, 'FACTORY'],
  [12, 'ERROR'],
  [13, 'REMOTE_CONTROL'],
  [14, 'SLEEPING'],
  [15, 'SELF_REPAIR'],
  [16, 'FACTORY_FUNCTION_TEST'],
  [17, 'STANDBY'],
  [18, 'SEGMENT_CLEANING'],
  [19, 'ZONE_CLEANING'],
  [20, 'SPOT_CLEANING'],
  [21, 'FAST_MAPPING'],
  [22, 'CRUISING_PATH'],
  [23, 'CRUISING_POINT'],
  [24, 'SUMMON_CLEAN'],
  [25, 'SHORTCUT'],
  [26, 'PERSON_FOLLOW'],
  [27, 'PET_GUARDING'],
  [28, 'AUTO_ARRANGEMENT'],
  [29, 'SMART_ARRANGEMENT'],
  [30, 'ZONED_ARRANGEMENT'],
  [1501, 'WATER_CHECK'],
]

/** `DreameVacuumTaskStatus` (TASK_STATUS, siid 4 piid 7) — Tasshack `types.py`. */
const TS_TASK_STATUS: ReadonlyArray<readonly [number, string]> = [
  [0, 'COMPLETED'],
  [1, 'AUTO_CLEANING'],
  [2, 'ZONE_CLEANING'],
  [3, 'SEGMENT_CLEANING'],
  [4, 'SPOT_CLEANING'],
  [5, 'FAST_MAPPING'],
  [6, 'AUTO_CLEANING_PAUSED'],
  [7, 'ZONE_CLEANING_PAUSED'],
  [8, 'SEGMENT_CLEANING_PAUSED'],
  [9, 'SPOT_CLEANING_PAUSED'],
  [10, 'MAP_CLEANING_PAUSED'],
  [11, 'DOCKING_PAUSED'],
  [12, 'MOPPING_PAUSED'],
  [13, 'SEGMENT_MOPPING_PAUSED'],
  [14, 'ZONE_MOPPING_PAUSED'],
  [15, 'AUTO_MOPPING_PAUSED'],
  [16, 'AUTO_DOCKING_PAUSED'],
  [17, 'SEGMENT_DOCKING_PAUSED'],
  [18, 'ZONE_DOCKING_PAUSED'],
  [20, 'CRUISING_PATH'],
  [21, 'CRUISING_PATH_PAUSED'],
  [22, 'CRUISING_POINT'],
  [23, 'CRUISING_POINT_PAUSED'],
  [24, 'SUMMON_CLEAN_PAUSED'],
  [25, 'RETURNING_INSTALL_MOP'],
  [26, 'RETURNING_REMOVE_MOP'],
  [27, 'STATION_CLEANING'],
  [30, 'PET_FINDING'],
  [31, 'AUTO_CLEANING_WASHING_PAUSED'],
  [32, 'AREA_CLEANING_WASHING_PAUSED'],
  [33, 'CUSTOM_CLEANING_WASHING_PAUSED'],
  [34, 'PICKING_UP_ITEM'],
  [35, 'PICKING_UP_ITEM_PAUSED'],
  [36, 'PICKING_UP_ITEM_SUCCESS'],
  [37, 'REMOTE_PICKUP_INITIALIZING'],
  [38, 'REMOTE_PICKUP_IDENTIFYING'],
  [39, 'MANUAL_REMOTE_PICKUP'],
  [40, 'AUTOMATIC_REMOTE_PICKUP'],
  [41, 'REMOTE_PICKUP_IN_PROGRESS'],
  [42, 'REMOTE_PICKUP_PAUSED'],
  [43, 'PLACING_ITEM'],
  [44, 'PLACING_ITEM_PAUSED'],
]

/**
 * Read-only enum-state sensors (diagnostics). `status` (4/1) + `task` (4/7) use
 * the Tasshack maps above (nodedreame mislabels 4/1); `charging-status` (3/2) +
 * `error` (2/2) use nodedreame's verified enums (cross-checked against HA). The
 * main robot STATE (siid 2 piid 1) is omitted — it is the primary Vacuum child's
 * state. Presence-driven. An int not in a map surfaces as its raw string.
 */
export const DREAME_ENUM_SENSORS: readonly EnumSensorDescriptor[] = [
  {
    key: 'status',
    label: 'Status',
    siid: 4,
    piid: 1,
    options: tupleOptions(TS_STATUS),
    section: DIAG,
  },
  {
    key: 'task',
    label: 'Task Status',
    siid: 4,
    piid: 7,
    options: tupleOptions(TS_TASK_STATUS),
    section: DIAG,
  },
  {
    key: 'charging-status',
    label: 'Charging Status',
    siid: 3,
    piid: 2,
    options: enumOptions(ChargingStatus),
    section: DIAG,
  },
  {
    key: 'error',
    label: 'Error',
    siid: 2,
    piid: 2,
    options: errorEnumOptions(),
    section: DIAG,
  },
  // Tank / dock / task diagnostic statuses — int→label maps from Tasshack
  // `types.py` (DreameVacuumWaterTank / DustCollection / AutoEmptyStatus /
  // SelfWashBaseStatus / LowWaterWarning / DrainageStatus / TaskType /
  // CleanWaterTankStatus / DetergentStatus / RelocationStatus). Presence-driven.
  {
    key: 'water-tank',
    label: 'Water Tank',
    siid: 4,
    piid: 6,
    options: tupleOptions([
      [0, 'NOT_INSTALLED'],
      [1, 'INSTALLED'],
      [10, 'MOP_INSTALLED'],
      [99, 'MOP_IN_STATION'],
    ]),
    section: DIAG,
  },
  {
    key: 'dust-collection',
    label: 'Dust Collection',
    siid: 15,
    piid: 3,
    options: tupleOptions([
      [0, 'NOT_AVAILABLE'],
      [1, 'AVAILABLE'],
      [2, 'OVER_USE'],
      [3, 'NEVER'],
    ]),
    section: DIAG,
  },
  {
    key: 'auto-empty-status',
    label: 'Auto Empty Status',
    siid: 15,
    piid: 5,
    options: tupleOptions([
      [0, 'IDLE'],
      [1, 'ACTIVE'],
      [2, 'NOT_PERFORMED'],
    ]),
    section: DIAG,
  },
  {
    key: 'self-wash-base-status',
    label: 'Self-Wash Base Status',
    siid: 4,
    piid: 25,
    options: tupleOptions([
      [0, 'IDLE'],
      [1, 'WASHING'],
      [2, 'DRYING'],
      [3, 'RETURNING'],
      [4, 'PAUSED'],
      [5, 'CLEAN_ADD_WATER'],
      [6, 'ADDING_WATER'],
      [7, 'RETURNING_FOR_DRY_MOP'],
    ]),
    section: DIAG,
  },
  {
    key: 'low-water-warning',
    label: 'Low Water Warning',
    siid: 4,
    piid: 41,
    options: tupleOptions([
      [0, 'NO_WARNING'],
      [1, 'NO_WATER_LEFT_DISMISS'],
      [2, 'NO_WATER_LEFT'],
      [3, 'NO_WATER_LEFT_AFTER_CLEAN'],
      [4, 'NO_WATER_FOR_CLEAN'],
      [5, 'LOW_WATER'],
      [6, 'TANK_NOT_INSTALLED'],
    ]),
    section: DIAG,
  },
  {
    key: 'drainage-status',
    label: 'Drainage Status',
    siid: 4,
    piid: 60,
    options: tupleOptions([
      [0, 'IDLE'],
      [1, 'DRAINING'],
      [2, 'DRAINING_SUCCESS'],
      [3, 'DRAINING_FAILED'],
    ]),
    section: DIAG,
  },
  {
    key: 'task-type',
    label: 'Task Type',
    siid: 4,
    piid: 58,
    options: tupleOptions([
      [0, 'IDLE'],
      [1, 'STANDARD'],
      [2, 'STANDARD_PAUSED'],
      [3, 'CUSTOM'],
      [4, 'CUSTOM_PAUSED'],
      [5, 'SHORTCUT'],
      [6, 'SHORTCUT_PAUSED'],
      [7, 'SCHEDULED'],
      [8, 'SCHEDULED_PAUSED'],
      [9, 'SMART'],
      [10, 'SMART_PAUSED'],
      [11, 'PARTIAL'],
      [12, 'PARTIAL_PAUSED'],
      [13, 'SUMMON'],
      [14, 'SUMMON_PAUSED'],
      [15, 'WATER_STAIN'],
      [16, 'WATER_STAIN_PAUSED'],
      [17, 'BOOSTED_EDGE_CLEANING'],
      [18, 'HAIR_COMPRESSING'],
      [19, 'LARGE_PARTICLE_CLEANING'],
      [20, 'INTENSIVE_STAIN_CLEANING'],
      [21, 'STAIN_CLEANING'],
      [22, 'INITIAL_DEEP_CLEANING'],
      [23, 'INITIAL_DEEP_CLEANING_PAUSED'],
      [24, 'MOP_PAD_HEATING'],
      [25, 'CLEANING_AFTER_MAPPING'],
      [26, 'SMALL_PARTICLE_CLEANING'],
      [30, 'CHANGING_MOP'],
      [31, 'CHANGING_MOP_PAUSED'],
      [32, 'FLOOR_MAINTAINING'],
      [33, 'FLOOR_MAINTAINING_PAUSED'],
      [34, 'ARRANGING_ITEMS'],
      [35, 'ARRANGING_ITEMS_PAUSED'],
      [36, 'INTENSIVE_HAIR_CLEANING'],
      [37, 'ACCESSORY_HANDLING'],
      [38, 'INCREASED_DRUM_SPEED_CLEANING'],
      [39, 'PRESSURIZED_CLEANING'],
      [40, 'STEAM_CLEANING'],
      [41, 'STEAM_CLEANING_PAUSED'],
    ]),
    section: DIAG,
  },
  {
    key: 'clean-water-tank-status',
    label: 'Clean Water Tank Status',
    siid: 27,
    piid: 1,
    options: tupleOptions([
      [0, 'INSTALLED'],
      [1, 'NOT_INSTALLED'],
      [2, 'LOW_WATER'],
      [3, 'CHECKING'],
    ]),
    section: DIAG,
  },
  {
    key: 'detergent-status',
    label: 'Detergent Status',
    siid: 27,
    piid: 4,
    options: tupleOptions([
      [0, 'INSTALLED'],
      [1, 'DISABLED'],
      [2, 'LOW_DETERGENT'],
    ]),
    section: DIAG,
  },
  {
    key: 'relocation-status',
    label: 'Relocation Status',
    siid: 4,
    piid: 20,
    options: tupleOptions([
      [0, 'LOCATED'],
      [1, 'LOCATING'],
      [10, 'FAILED'],
      [11, 'SUCCESS'],
    ]),
    section: DIAG,
  },
]

/**
 * MOWER read-only diagnostic enum sensors (Dreame lawn mower, e.g. p2255). The
 * mower's MIoT property space differs from the vacuum's, so it has its own
 * catalog; the option maps come from nodedreame's mower enums. Spawned ONLY for
 * mower containers (see DreameContainerDevice), presence-filtered like the
 * vacuum diagnostics. The shared `enum-sensor` cap renders the mapped value.
 */
export const DREAME_MOWER_ENUM_SENSORS: readonly EnumSensorDescriptor[] = [
  {
    key: 'mower-status',
    label: 'Status',
    siid: 2,
    piid: 1,
    options: enumOptions(MowerStatus),
    section: DIAG,
  },
  {
    key: 'mower-charging-status',
    label: 'Charging Status',
    siid: 3,
    piid: 2,
    options: enumOptions(MowerChargingStatus),
    section: DIAG,
  },
  {
    key: 'mower-task-status',
    label: 'Task Status',
    siid: 5,
    piid: 104,
    options: enumOptions(MowerTaskStatus),
    section: DIAG,
  },
  {
    key: 'mower-fault',
    label: 'Fault',
    siid: 2,
    piid: 2,
    options: enumOptions(MowerFault),
    section: DIAG,
  },
]

/**
 * A writable numeric setting exposed as a `DeviceType.Control` (`numeric-control`
 * role) child, backed by ONE direct MIoT property holding a number. min/max/step
 * are the device's accepted range (verified against nodedreame / the live model);
 * the `control` slice carries them so the UI renders a bounded slider.
 */
export interface NumberDescriptor {
  readonly key: string
  readonly label: string
  readonly siid: number
  readonly piid: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly unit?: string
  readonly section: string
}

/**
 * Direct-property numbers (writable numeric settings). Only the VERIFIED range is
 * listed — voice VOLUME (nodedreame `SETTINGS_PROP.VOLUME` siid 7 piid 1, 0..100).
 * Other HA numbers (self-clean area/time, …) need their siid/piid + range verified
 * before they ship (cf. the cleaning-mode select deferral). Presence-driven.
 */
export const DREAME_NUMBERS: readonly NumberDescriptor[] = [
  {
    key: 'volume',
    label: 'Volume',
    siid: 7,
    piid: 1,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    section: S_GENERAL,
  },
  {
    // Tasshack `number.py` WETNESS_LEVEL (mop wetness), range 1..32 step 1.
    key: 'wetness-level',
    label: 'Wetness Level',
    siid: 28,
    piid: 1,
    min: 1,
    max: 32,
    step: 1,
    section: S_STATION,
  },
  {
    // Tasshack `number.py` DRYING_TIME (siid 4 piid 40), 2..12 hours step 1.
    // HA also surfaces this as a discrete "Xh" select; the raw prop is the hour
    // count, so a number is the faithful, simplest representation.
    key: 'drying-time',
    label: 'Drying Time',
    siid: 4,
    piid: 40,
    min: 2,
    max: 12,
    step: 1,
    unit: 'h',
    section: S_STATION,
  },
  {
    // Tasshack `number.py` CAMERA_LIGHT_BRIGHTNESS (siid 10001 piid 9), 40..100%.
    // Only present on camera-equipped models (the prop is reported then).
    key: 'camera-light-brightness',
    label: 'Camera Light Brightness',
    siid: 10001,
    piid: 9,
    min: 40,
    max: 100,
    step: 1,
    unit: '%',
    section: S_GENERAL,
  },
]

/**
 * A boolean toggle inside the PACKED `AUTO_SWITCH_SETTINGS` bundle (siid 4 piid
 * 50). Unlike a direct switch it has no siid/piid of its own — it is addressed by
 * its `autoSwitchKey` through nodedreame's auto-switch codec
 * (`vacuum.autoSwitchProperty(key)` / `setAutoSwitchProperty(key, 0|1)`). The set
 * of bool-vs-enum auto-switch keys follows Tasshack's switch.py / select.py split.
 */
export interface AutoSwitchDescriptor {
  readonly key: string
  readonly label: string
  readonly autoSwitchKey: AutoSwitchKey
  readonly section: string
}

/**
 * Auto-switch BOOLEAN toggles (Tasshack switch.py `DreameVacuumAutoSwitchProperty`
 * entries). Presence-driven via `vacuum.supportedAutoSwitchKeys` + a non-negative
 * value (a `-1` value is the "not applicable on this firmware" sentinel).
 */
export const DREAME_AUTO_SWITCHES: readonly AutoSwitchDescriptor[] = [
  {
    key: 'collision-avoidance',
    label: 'Collision Avoidance',
    autoSwitchKey: 'collisionAvoidance',
    section: S_CLEAN,
  },
  {
    key: 'stain-avoidance',
    label: 'Stain Avoidance',
    autoSwitchKey: 'stainAvoidance',
    section: S_CLEAN,
  },
  {
    key: 'floor-direction-cleaning',
    label: 'Floor Direction Cleaning',
    autoSwitchKey: 'floorDirectionCleaning',
    section: S_CLEAN,
  },
  {
    key: 'pet-focused-cleaning',
    label: 'Pet-Focused Cleaning',
    autoSwitchKey: 'petFocusedCleaning',
    section: S_CLEAN,
  },
  {
    key: 'max-suction-power',
    label: 'Max Suction Power',
    autoSwitchKey: 'maxSuctionPower',
    section: S_CLEAN,
  },
  {
    key: 'gap-cleaning-extension',
    label: 'Gap Cleaning Extension',
    autoSwitchKey: 'gapCleaningExtension',
    section: S_CLEAN,
  },
  {
    key: 'mopping-under-furnitures',
    label: 'Mopping Under Furniture',
    autoSwitchKey: 'moppingUnderFurnitures',
    section: S_CLEAN,
  },
  { key: 'mop-extend', label: 'Mop Extend', autoSwitchKey: 'mopExtend', section: S_CLEAN },
  { key: 'side-reach', label: 'Side Reach', autoSwitchKey: 'sideReach', section: S_CLEAN },
  {
    key: 'intensive-carpet-cleaning',
    label: 'Intensive Carpet Cleaning',
    autoSwitchKey: 'intensiveCarpetCleaning',
    section: S_CARPET,
  },
  { key: 'auto-drying', label: 'Auto Drying', autoSwitchKey: 'autoDrying', section: S_STATION },
  { key: 'smart-drying', label: 'Smart Drying', autoSwitchKey: 'smartDrying', section: S_STATION },
  { key: 'hot-washing', label: 'Hot Washing', autoSwitchKey: 'hotWashing', section: S_STATION },
  {
    key: 'uv-sterilization',
    label: 'UV Sterilization',
    autoSwitchKey: 'uvSterilization',
    section: S_STATION,
  },
  {
    key: 'ultra-clean-mode',
    label: 'Ultra Clean Mode',
    autoSwitchKey: 'ultraCleanMode',
    section: S_STATION,
  },
  { key: 'fill-light', label: 'Fill Light', autoSwitchKey: 'fillLight', section: S_GENERAL },
  {
    key: 'auto-charging',
    label: 'Auto Charging',
    autoSwitchKey: 'autoCharging',
    section: S_GENERAL,
  },
  { key: 'human-follow', label: 'Human Follow', autoSwitchKey: 'humanFollow', section: S_GENERAL },
  {
    key: 'streaming-voice-prompt',
    label: 'Streaming Voice Prompt',
    autoSwitchKey: 'streamingVoicePrompt',
    section: S_GENERAL,
  },
]

/**
 * An enum inside the PACKED `AUTO_SWITCH_SETTINGS` bundle — addressed by
 * `autoSwitchKey` (not a direct siid/piid) and rendered as a select. int→label
 * maps from Tasshack `types.py` (`DreameVacuumMoppingType` / `CleanGenius` / etc.).
 */
export interface AutoSelectDescriptor {
  readonly key: string
  readonly label: string
  readonly autoSwitchKey: AutoSwitchKey
  readonly options: readonly SelectOption[]
  readonly section: string
}

/** Auto-switch ENUM settings (Tasshack select.py `DreameVacuumAutoSwitchProperty`). */
export const DREAME_AUTO_SELECTS: readonly AutoSelectDescriptor[] = [
  {
    key: 'mopping-type',
    label: 'Mopping Type',
    autoSwitchKey: 'moppingType',
    options: [
      { value: 0, label: 'Daily' },
      { value: 1, label: 'Accurate' },
      { value: 2, label: 'Deep' },
    ],
    section: S_CLEAN,
  },
  {
    key: 'cleangenius',
    label: 'CleanGenius',
    autoSwitchKey: 'cleanGenius',
    options: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'Routine Cleaning' },
      { value: 2, label: 'Deep Cleaning' },
    ],
    section: S_CLEAN,
  },
  {
    key: 'wider-corner-coverage',
    label: 'Wider Corner Coverage',
    autoSwitchKey: 'widerCornerCoverage',
    options: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'High Frequency' },
      { value: 7, label: 'Low Frequency' },
    ],
    section: S_CLEAN,
  },
  {
    key: 'cleaning-route',
    label: 'Cleaning Route',
    autoSwitchKey: 'cleaningRoute',
    options: [
      { value: 0, label: 'Not Set' },
      { value: 1, label: 'Standard' },
      { value: 2, label: 'Intensive' },
      { value: 3, label: 'Deep' },
      { value: 4, label: 'Quick' },
    ],
    section: S_CLEAN,
  },
  {
    key: 'mop-extend-frequency',
    label: 'Mop Extend Frequency',
    autoSwitchKey: 'mopExtendFrequency',
    options: [
      { value: 1, label: 'Intelligent' },
      { value: 2, label: 'High' },
      { value: 7, label: 'Standard' },
    ],
    section: S_CLEAN,
  },
  {
    key: 'auto-recleaning',
    label: 'Auto Re-Cleaning',
    autoSwitchKey: 'autoRecleaning',
    options: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'In Deep Mode' },
      { value: 2, label: 'In All Modes' },
    ],
    section: S_STATION,
  },
  {
    key: 'auto-rewashing',
    label: 'Auto Re-Washing',
    autoSwitchKey: 'autoRewashing',
    options: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'In Deep Mode' },
      { value: 2, label: 'In All Modes' },
    ],
    section: S_STATION,
  },
  {
    key: 'mop-pad-swing',
    label: 'Mop Pad Swing',
    autoSwitchKey: 'mopPadSwing',
    options: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'Auto' },
      { value: 2, label: 'Daily' },
      { value: 7, label: 'Weekly' },
    ],
    section: S_STATION,
  },
  {
    key: 'self-clean-frequency',
    label: 'Self-Clean Frequency',
    autoSwitchKey: 'selfCleanFrequency',
    options: [
      { value: 1, label: 'By Area' },
      { value: 2, label: 'By Time' },
      { value: 3, label: 'By Room' },
      { value: 4, label: 'Intelligent' },
    ],
    section: S_STATION,
  },
]

/** The packed `AUTO_SWITCH_SETTINGS` MIoT prop (siid 4 piid 50) — seeded once so
 *  the auto-switch/-select children can presence-detect + read at spawn. */
const AUTO_SWITCH_SETTINGS_PROP: MiotProp = { siid: 4, piid: 50 }

/** Every MIoT property the catalog needs seeded (for presence-detection at
 *  spawn + value reads). Deduped across all catalog entity types — includes the
 *  select value props and the button presence props. */
export function catalogProps(): readonly MiotProp[] {
  const seen = new Set<string>()
  const props: MiotProp[] = []
  const add = (siid: number, piid: number): void => {
    const k = `${siid}/${piid}`
    if (!seen.has(k)) {
      seen.add(k)
      props.push({ siid, piid })
    }
  }
  for (const s of DREAME_NUMERIC_SENSORS) add(s.siid, s.piid)
  for (const s of DREAME_SWITCHES) add(s.siid, s.piid)
  for (const s of DREAME_SELECTS) add(s.siid, s.piid)
  for (const s of DREAME_ENUM_SENSORS) add(s.siid, s.piid)
  for (const s of DREAME_MOWER_ENUM_SENSORS) add(s.siid, s.piid)
  for (const s of DREAME_NUMBERS) add(s.siid, s.piid)
  // The packed auto-switch bundle is ONE prop addressing all auto_switch/-select
  // entities; seed it once when any are catalogued.
  if (DREAME_AUTO_SWITCHES.length > 0 || DREAME_AUTO_SELECTS.length > 0) {
    add(AUTO_SWITCH_SETTINGS_PROP.siid, AUTO_SWITCH_SETTINGS_PROP.piid)
  }
  for (const b of DREAME_BUTTONS) {
    if (b.presenceSiid !== undefined && b.presencePiid !== undefined) {
      add(b.presenceSiid, b.presencePiid)
    }
  }
  return props
}
