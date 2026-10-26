/**
 * Per-DeviceType control registry.
 *
 * Single source of truth for which InlineControl (row) and HeroCard
 * (device-detail hero area) to render for each DeviceType. Both the
 * device-list row and the device-detail hero card pull from this
 * registry, so they can never diverge.
 *
 * The mapping is EXHAUSTIVE — `Record<DeviceType, DeviceTypeControl>`
 * means omitting a new enum member fails the build.
 */
import type { ReactNode } from 'react'
import { DeviceType, resolveDeviceControlKind, DEVICE_TYPE_CONTROL_KIND } from '@camstack/types'
import type { DeviceControlKind } from '@camstack/types'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { FILL, RIGHT, CENTER, FIT, type ControlAlign } from './atoms'
import { ButtonControl, ButtonHeroCard } from './button-control'
import { CoverInlineControl } from './cover-inline'
import { CoverHeroCard } from './cover-hero-card'
import { DummyInline, DummyHeroCard } from './dummy-hero-card'
import { SensorInlineControl } from './sensor-inline-control'
import { SensorHeroCard } from './sensor-hero-card'
import { UpdateInlineControl, UpdateHeroCard } from './update-control'
import { VacuumInlineControl, VacuumHeroCard } from './vacuum-control'
import { LawnMowerInlineControl, LawnMowerHeroCard } from './lawn-mower-control'
import { ValveInlineControl, ValveHeroCard } from './valve-control'
import { HumidifierInlineControl, HumidifierHeroCard } from './humidifier-control'
import { WaterHeaterInlineControl, WaterHeaterHeroCard } from './water-heater-control'
import { WeatherInlineControl, WeatherHeroCard } from './weather-control'
import { ImageInlineControl, ImageHeroCard } from './image-control'
import { PetFeederInlineControl, PetFeederHeroCard } from './pet-feeder-panel'
import { DishwasherInlineControl, DishwasherHeroCard } from './dishwasher-control'
import {
  SwitchInlineControl,
  SwitchHeroCard,
  LockInlineControl,
  LockHeroCard,
  LightInlineControl,
  LightHeroCard,
  FanInlineControl,
  FanHeroCard,
  ThermostatInlineControl,
  ThermostatHeroCard,
  AcInlineControl,
  AcHeroCard,
  MediaPlayerInlineControl,
  MediaPlayerHeroCard,
  AlarmPanelInlineControl,
  AlarmHeroCard,
  ScriptInlineControl,
  ScriptHeroCard,
  AutomationInlineControl,
  AutomationHeroCard,
  ControlInlineControl,
  ControlHeroCard,
} from './panel-controls'

// Re-export so consumers can import coverHighlight from the registry module
// rather than from the implementation file directly.
export { coverHighlight } from './cover-inline'

export interface DeviceControlProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
  readonly features: readonly string[] | undefined
  /** Enable optimistic UI mode (default: true). Set to false to disable. */
  readonly optimistic?: boolean
}

export interface DeviceTypeControl {
  /** Compact, state-aware controls rendered directly in a device-list row. */
  readonly InlineControl: (p: DeviceControlProps) => ReactNode
  /** Full control surface rendered as a card in the device-detail hero area. */
  readonly HeroCard: (p: DeviceControlProps) => ReactNode
}

const COVER_CONTROL: DeviceTypeControl = {
  InlineControl: CoverInlineControl,
  HeroCard: CoverHeroCard,
}

const DUMMY_CONTROL: DeviceTypeControl = {
  InlineControl: DummyInline,
  HeroCard: DummyHeroCard,
}

const SENSOR_CONTROL: DeviceTypeControl = {
  InlineControl: SensorInlineControl,
  HeroCard: SensorHeroCard,
}

const UPDATE_CONTROL: DeviceTypeControl = {
  InlineControl: UpdateInlineControl,
  HeroCard: UpdateHeroCard,
}

const SWITCH_CONTROL: DeviceTypeControl = {
  InlineControl: SwitchInlineControl,
  HeroCard: SwitchHeroCard,
}

const LOCK_CONTROL: DeviceTypeControl = {
  InlineControl: LockInlineControl,
  HeroCard: LockHeroCard,
}

const LIGHT_CONTROL: DeviceTypeControl = {
  InlineControl: LightInlineControl,
  HeroCard: LightHeroCard,
}

const FAN_CONTROL: DeviceTypeControl = {
  InlineControl: FanInlineControl,
  HeroCard: FanHeroCard,
}

const THERMOSTAT_CONTROL: DeviceTypeControl = {
  InlineControl: ThermostatInlineControl,
  HeroCard: ThermostatHeroCard,
}

const CLIMATE_CONTROL: DeviceTypeControl = {
  InlineControl: AcInlineControl,
  HeroCard: AcHeroCard,
}

const MEDIA_PLAYER_CONTROL: DeviceTypeControl = {
  InlineControl: MediaPlayerInlineControl,
  HeroCard: MediaPlayerHeroCard,
}

const ALARM_PANEL_CONTROL: DeviceTypeControl = {
  InlineControl: AlarmPanelInlineControl,
  HeroCard: AlarmHeroCard,
}

const SCRIPT_CONTROL: DeviceTypeControl = {
  InlineControl: ScriptInlineControl,
  HeroCard: ScriptHeroCard,
}

const AUTOMATION_CONTROL: DeviceTypeControl = {
  InlineControl: AutomationInlineControl,
  HeroCard: AutomationHeroCard,
}

const CONTROL_CONTROL: DeviceTypeControl = {
  InlineControl: ControlInlineControl,
  HeroCard: ControlHeroCard,
}

const VACUUM_CONTROL: DeviceTypeControl = {
  InlineControl: VacuumInlineControl,
  HeroCard: VacuumHeroCard,
}

const LAWN_MOWER_CONTROL: DeviceTypeControl = {
  InlineControl: LawnMowerInlineControl,
  HeroCard: LawnMowerHeroCard,
}

const VALVE_CONTROL: DeviceTypeControl = {
  InlineControl: ValveInlineControl,
  HeroCard: ValveHeroCard,
}

const HUMIDIFIER_CONTROL: DeviceTypeControl = {
  InlineControl: HumidifierInlineControl,
  HeroCard: HumidifierHeroCard,
}

const WATER_HEATER_CONTROL: DeviceTypeControl = {
  InlineControl: WaterHeaterInlineControl,
  HeroCard: WaterHeaterHeroCard,
}

const WEATHER_CONTROL: DeviceTypeControl = {
  InlineControl: WeatherInlineControl,
  HeroCard: WeatherHeroCard,
}

const IMAGE_CONTROL: DeviceTypeControl = {
  InlineControl: ImageInlineControl,
  HeroCard: ImageHeroCard,
}

const PET_FEEDER_CONTROL: DeviceTypeControl = {
  InlineControl: PetFeederInlineControl,
  HeroCard: PetFeederHeroCard,
}

const DISHWASHER_CONTROL: DeviceTypeControl = {
  InlineControl: DishwasherInlineControl,
  HeroCard: DishwasherHeroCard,
}

const BUTTON_CONTROL: DeviceTypeControl = {
  InlineControl: ButtonControl,
  HeroCard: ButtonHeroCard,
}

/**
 * Presentation binding: the shared `DeviceControlKind` (decided in
 * `@camstack/types` `resolveDeviceControlKind`) → this platform's web
 * components. Exhaustive over `DeviceControlKind` — omitting a kind fails the
 * build here. The type→kind DECISION is single-sourced in `@camstack/types`;
 * this map only binds a kind to its web widgets.
 */
const CONTROL_KIND_COMPONENTS: Record<DeviceControlKind, DeviceTypeControl> = {
  cover: COVER_CONTROL,
  valve: VALVE_CONTROL,
  humidifier: HUMIDIFIER_CONTROL,
  'water-heater': WATER_HEATER_CONTROL,
  switch: SWITCH_CONTROL,
  light: LIGHT_CONTROL,
  fan: FAN_CONTROL,
  sensor: SENSOR_CONTROL,
  thermostat: THERMOSTAT_CONTROL,
  climate: CLIMATE_CONTROL,
  button: BUTTON_CONTROL,
  update: UPDATE_CONTROL,
  lock: LOCK_CONTROL,
  'media-player': MEDIA_PLAYER_CONTROL,
  alarm: ALARM_PANEL_CONTROL,
  control: CONTROL_CONTROL,
  weather: WEATHER_CONTROL,
  vacuum: VACUUM_CONTROL,
  'lawn-mower': LAWN_MOWER_CONTROL,
  image: IMAGE_CONTROL,
  'pet-feeder': PET_FEEDER_CONTROL,
  dishwasher: DISHWASHER_CONTROL,
  script: SCRIPT_CONTROL,
  automation: AUTOMATION_CONTROL,
  dummy: DUMMY_CONTROL,
}

/**
 * Exhaustive record over DeviceType, DERIVED from the shared decision
 * (`DEVICE_TYPE_CONTROL_KIND`) composed with the web `CONTROL_KIND_COMPONENTS`
 * binding — so the type→control mapping can never diverge from the single
 * source in `@camstack/types`. Preserved as a public export for consumers/tests
 * that index it by `DeviceType`.
 *
 * The `Object.fromEntries` result is a `{ [k: string]: DeviceTypeControl }`;
 * `Object.values(DeviceType)` (a string enum) yields exactly the enum's members,
 * so the record is fully populated — the assertion narrows that documented
 * enum-record projection boundary.
 */
export const DEVICE_TYPE_CONTROL: Record<DeviceType, DeviceTypeControl> = Object.fromEntries(
  Object.values(DeviceType).map((type) => [
    type,
    CONTROL_KIND_COMPONENTS[DEVICE_TYPE_CONTROL_KIND[type]],
  ]),
) as Record<DeviceType, DeviceTypeControl>

/**
 * Per-type FILL flag.
 *
 *   true  — range / choice / button controls (cover ▲■▼ triad, thermostat
 *           setpoint stepper, media/control/button action buttons, alarm
 *           segmented control). The child STRETCHES to the full column width.
 *   false — readouts, tap-toggles, icon controls (lock), and dummy/placeholder
 *           types. The child keeps its NATURAL width; where it sits in the
 *           column (flush right vs centered) is decided by the caller via a
 *           `ControlPlacement` — see `resolveControlAlign`.
 *
 * Dummy types (Camera, Hub, Generic, Weather, Vacuum, Container, and placeholder
 * types Notifier/Script/Automation whose InlineControl renders "—") are `false` —
 * the dash placeholder must not be stretched to the full column width. (AlarmPanel
 * has a real segmented inline control and is `true`.) When a later task gives a
 * remaining placeholder type a real stretchy inline control, flip its flag to true.
 *
 * Exhaustive over DeviceType — a missing member is a TypeScript build error.
 */
export const CONTROL_FILLS: Record<DeviceType, boolean> = {
  // ── FILL: range / choice / button controls ─────────────────────────
  [DeviceType.Cover]: true,
  // Valve has the cover-style ▲■▼ triad → FILL.
  [DeviceType.Valve]: true,
  [DeviceType.Thermostat]: true,
  [DeviceType.Climate]: true,
  [DeviceType.Control]: true,
  [DeviceType.Button]: true,
  [DeviceType.MediaPlayer]: true,
  [DeviceType.AlarmPanel]: true,
  // ── natural width: icon controls (lock renders small state/open icons;
  //    vacuum/lawn-mower render small action buttons + battery badge) ─
  [DeviceType.Lock]: false,
  [DeviceType.Vacuum]: false,
  [DeviceType.LawnMower]: false,
  // ── natural width: toggles ─────────────────────────────────────────
  // Humidifier inline = on/off toggle + current→target readout (natural width).
  [DeviceType.Humidifier]: false,
  [DeviceType.Switch]: false,
  [DeviceType.Siren]: false,
  [DeviceType.Light]: false,
  [DeviceType.Fan]: false,
  // ── natural width: readouts ────────────────────────────────────────
  // Water heater inline = current→target° readout + mode hint (natural width).
  [DeviceType.WaterHeater]: false,
  [DeviceType.Sensor]: false,
  [DeviceType.Presence]: false,
  // ── natural width: readout (event stream, no interactive control) ──────
  [DeviceType.EventEmitter]: false,
  // ── natural width: DummyInline placeholder ("—") — no real control yet ─
  [DeviceType.Notifier]: false,
  // Script inline = Run/Stop button + "3 min ago"; automation inline =
  // enabled pill + Trigger. Both are natural width.
  [DeviceType.Script]: false,
  [DeviceType.Automation]: false,
  // ── natural width: DummyInline placeholder ("—") ───────────────────
  [DeviceType.Camera]: false,
  [DeviceType.Hub]: false,
  [DeviceType.Update]: false,
  [DeviceType.Generic]: false,
  // Weather inline = condition icon + temperature readout (readout, natural width).
  [DeviceType.Weather]: false,
  [DeviceType.Container]: false,
  // Image inline = small thumbnail / placeholder (readout, natural width).
  [DeviceType.Image]: false,
  // Pet feeder inline = food/battery readout + a natural-width Feed button.
  [DeviceType.PetFeeder]: false,
  [DeviceType.Dishwasher]: false,
  [DeviceType.Washer]: false,
  [DeviceType.Dryer]: false,
}

/**
 * Where a control sits, and whether the column carries the fixed `w-[140px]` box.
 *   'right'  — natural-width content flush to the fixed column's right edge (card / minimal views).
 *   'center' — natural-width content centered in the fixed column.
 *   'table'  — the column DROPS its fixed width and sizes to its content (table view). Every type
 *              resolves to FIT so the control takes its natural width and lays out in sequence with
 *              the trailing trash + status dot, never overflowing a fixed box and colliding.
 * FILL controls ignore 'right'/'center' (they always stretch to the fixed width); under 'table'
 * a FILL control simply takes its natural width in the content-sized wrapper.
 */
export type ControlPlacement = 'right' | 'center' | 'table'

const DEVICE_TYPE_VALUES = new Set<string>(Object.values(DeviceType))

/**
 * Runtime-string-safe lookup: a device row's `type` crosses the wire as a plain
 * string. The type→control-kind DECISION is single-sourced in `@camstack/types`
 * (`resolveDeviceControlKind`, null for an unrecognised type); this maps the
 * resolved kind onto the web components.
 */
export function resolveDeviceControl(type: string): DeviceTypeControl | null {
  const kind = resolveDeviceControlKind(type)
  return kind ? CONTROL_KIND_COMPONENTS[kind] : null
}

/**
 * Runtime-string-safe alignment lookup for the fixed-width control column.
 *
 * A device's `type` crosses the wire as a plain string;
 * `DEVICE_TYPE_VALUES.has(type)` narrows it to `DeviceType` before indexing
 * `CONTROL_FILLS`, making the cast sound. The `'table'` placement is
 * content-width for EVERY type (returns `FIT`), so a wide control never
 * overflows a fixed box — the FILL flag is irrelevant there. For the fixed-box
 * placements a FILL type always stretches (`FILL`) and a natural-width type is
 * placed by the caller's `placement` — `'center'` → `CENTER`, `'right'` →
 * `RIGHT` (card / minimal view). An unrecognised type falls back to
 * natural-width placement.
 */
export function resolveControlAlign(type: string, placement: ControlPlacement): ControlAlign {
  if (placement === 'table') return FIT
  const fills = DEVICE_TYPE_VALUES.has(type) && CONTROL_FILLS[type as DeviceType]
  return fills ? FILL : placement === 'center' ? CENTER : RIGHT
}
