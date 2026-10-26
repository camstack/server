/**
 * Device-control RESOLUTION LOGIC — the single, presentation-free source of
 * truth for "given a device's `type` (+ its cap `features`), which control
 * should render?".
 *
 * This module is deliberately framework-free: NO react / react-native / lucide
 * imports, no JSX, no platform widgets. It encodes only the DECISION; each
 * client (admin-ui's `@camstack/ui-library` web registry, the RN viewer's
 * accessory registry) maps the returned control-KIND onto its own
 * platform-specific components. That's the one duplication we remove — the
 * presentational components stay platform-specific by necessity.
 *
 * Two decision surfaces live here, at two granularities:
 *
 *  1. `resolveDeviceControlKind(type)` — the BASE type → control-kind decision
 *     used by the admin-ui device list / device-detail hero. Exhaustive over
 *     every `DeviceType`; a light is a single `'light'` kind (dim-vs-plain is
 *     refined inside the light component).
 *
 *  2. `pickAccessoryControl({ type, features })` — the FINER accessory-row
 *     decision used by the viewer's per-camera accessory list. It refines a
 *     `light` into `'brightness'` vs `'switch'` and a `sensor`/`presence` into
 *     a specific sensor cap, because an accessory row renders ONE compact
 *     control chosen by priority.
 *
 * The two agree on every overlapping type EXCEPT `light` (see the notes on
 * `pickAccessoryControl`): the base decision keeps a dedicated `'light'`
 * control; the accessory decision collapses a non-dimmable light onto the
 * generic `'switch'` control. That is a deliberate granularity difference, not
 * a contradiction — the base kind is what the admin-ui renders, the accessory
 * pick is what a compact camera-accessory row renders.
 */
import { DeviceType } from './device-type.js'

// ── Base decision: DeviceType → control-kind ─────────────────────────────────

/**
 * The abstract control-kind a `DeviceType` resolves to. Each client binds
 * these kinds to its own components (web: `CONTROL_KIND_COMPONENTS`). A single
 * kind can back several device types (`'switch'` ← Switch + Siren, `'sensor'`
 * ← Sensor + Presence, `'dummy'` ← every placeholder/non-controllable type).
 */
export type DeviceControlKind =
  | 'cover'
  | 'valve'
  | 'humidifier'
  | 'water-heater'
  | 'switch'
  | 'light'
  | 'fan'
  | 'sensor'
  | 'thermostat'
  | 'climate'
  | 'button'
  | 'update'
  | 'lock'
  | 'media-player'
  | 'alarm'
  | 'control'
  | 'weather'
  | 'vacuum'
  | 'lawn-mower'
  | 'image'
  | 'pet-feeder'
  | 'dishwasher'
  | 'script'
  | 'automation'
  | 'dummy'

/**
 * Exhaustive `DeviceType` → `DeviceControlKind` map. Omitting a new enum member
 * fails the build here (the single place the type→kind decision is encoded).
 * `'dummy'` marks types with no interactive control (Camera/Hub/Generic and the
 * placeholder HA types whose inline control renders a dash).
 */
export const DEVICE_TYPE_CONTROL_KIND: Record<DeviceType, DeviceControlKind> = {
  [DeviceType.Cover]: 'cover',
  [DeviceType.Valve]: 'valve',
  [DeviceType.Humidifier]: 'humidifier',
  [DeviceType.WaterHeater]: 'water-heater',
  [DeviceType.Camera]: 'dummy',
  [DeviceType.Hub]: 'dummy',
  [DeviceType.Switch]: 'switch',
  [DeviceType.Siren]: 'switch',
  [DeviceType.Light]: 'light',
  [DeviceType.Fan]: 'fan',
  [DeviceType.Sensor]: 'sensor',
  [DeviceType.Thermostat]: 'thermostat',
  [DeviceType.Climate]: 'climate',
  [DeviceType.Button]: 'button',
  [DeviceType.EventEmitter]: 'dummy',
  [DeviceType.Update]: 'update',
  [DeviceType.Generic]: 'dummy',
  [DeviceType.Notifier]: 'dummy',
  [DeviceType.Script]: 'script',
  [DeviceType.Automation]: 'automation',
  [DeviceType.Lock]: 'lock',
  [DeviceType.MediaPlayer]: 'media-player',
  [DeviceType.AlarmPanel]: 'alarm',
  [DeviceType.Control]: 'control',
  [DeviceType.Presence]: 'sensor',
  [DeviceType.Weather]: 'weather',
  [DeviceType.Vacuum]: 'vacuum',
  [DeviceType.LawnMower]: 'lawn-mower',
  [DeviceType.Container]: 'dummy',
  [DeviceType.Image]: 'image',
  [DeviceType.PetFeeder]: 'pet-feeder',
  [DeviceType.Dishwasher]: 'dishwasher',
  // No program surface. The list row stays a placeholder; power and running
  // are readings on the device, not an inline control.
  [DeviceType.Washer]: 'dummy',
  [DeviceType.Dryer]: 'dummy',
}

const DEVICE_TYPE_VALUES = new Set<string>(Object.values(DeviceType))

/**
 * Runtime-string-safe base resolver: a device row's `type` crosses the wire as
 * a plain string, so an unrecognised value resolves to `null` instead of
 * indexing the map with an unverified key. `DEVICE_TYPE_VALUES.has(type)`
 * narrows the string to a `DeviceType` before indexing (documented enum-string
 * boundary).
 */
export function resolveDeviceControlKind(type: string): DeviceControlKind | null {
  return DEVICE_TYPE_VALUES.has(type) ? DEVICE_TYPE_CONTROL_KIND[type as DeviceType] : null
}

// ── Finer decision: accessory-row control pick (type + features) ─────────────

/** Identifier of the control kind an accessory row should render. `'none'` = no
 *  control. A subset of the surfaces the base decision covers, PLUS
 *  `'brightness'` (a dimmable light refined at the decision layer). */
export type AccessoryControlKind =
  | 'cover'
  | 'lock'
  | 'alarm'
  | 'valve'
  | 'brightness'
  | 'switch'
  | 'sensor'
  | 'none'

/** Kebab feature flag advertised by an accessory that auto-activates when its
 *  parent camera detects motion. The cap's kebab name is `motion-trigger` (see
 *  `motion-trigger.cap.ts`). It is INDEPENDENT of the row's primary control: a
 *  siren/light/switch can expose BOTH a `switch` on/off AND a `motion-trigger`
 *  "activate on motion" toggle. */
export const MOTION_TRIGGER_FEATURE = 'motion-trigger'

/** True when an accessory advertises the `motion-trigger` cap — drives the
 *  inline "On motion" toggle rendered alongside its primary control. Pure +
 *  testable. */
export function hasMotionTrigger(features: readonly string[]): boolean {
  return features.includes(MOTION_TRIGGER_FEATURE)
}

/** Kebab-case sensor cap names → the read-only sensor-value control. The
 *  accessory pick scans these (in order) to choose which sensor cap to read. */
export const SENSOR_FEATURES: readonly string[] = [
  'temperature-sensor',
  'humidity-sensor',
  'ambient-light-sensor',
  'numeric-sensor',
  'enum-sensor',
]

/** The chosen control plus the sensor feature (when `kind === 'sensor'`) so the
 *  renderer knows which sensor cap to read. */
export interface AccessoryControlPick {
  readonly kind: AccessoryControlKind
  /** The kebab sensor cap name to read, only set when `kind === 'sensor'`. */
  readonly sensorFeature?: string
}

/** The accessory fields the pick needs: its canonical `DeviceType` (as the
 *  wire string) plus the secondary cap `features` (used only to refine a light
 *  or sensor). */
export interface AccessoryControlInput {
  readonly type: string
  readonly features: readonly string[]
}

/**
 * Pick the primary control for an accessory. The control is chosen by the
 * device's canonical `type` (the `DeviceType` enum value — the same key
 * `resolveDeviceControlKind` maps on), NOT by the `features` list (which holds
 * secondary flags). For a `light` we consult `features` to choose dim vs plain
 * on/off, and for a `sensor`/`presence` to pick which sensor value to read.
 * Pure: same input → same output. Returns `{ kind: 'none' }` for types with no
 * accessory-row control.
 */
export function pickAccessoryControl(device: AccessoryControlInput): AccessoryControlPick {
  const set = new Set(device.features)
  switch (device.type) {
    case DeviceType.Cover:
      return { kind: 'cover' }
    case DeviceType.Valve:
      return { kind: 'valve' }
    case DeviceType.Lock:
      return { kind: 'lock' }
    case DeviceType.AlarmPanel:
      return { kind: 'alarm' }
    case DeviceType.Light:
      return set.has('brightness') ? { kind: 'brightness' } : { kind: 'switch' }
    case DeviceType.Switch:
    case DeviceType.Siren:
      return { kind: 'switch' }
    case DeviceType.Sensor:
    case DeviceType.Presence: {
      const sensor = SENSOR_FEATURES.find((f) => set.has(f))
      return sensor ? { kind: 'sensor', sensorFeature: sensor } : { kind: 'none' }
    }
    default:
      return { kind: 'none' }
  }
}

// ── Sensor-cap → read-only value mapping ─────────────────────────────────────

/** A sensor cap → its `(capKey, field, fallbackUnit)` mapping for the read-only
 *  value row. The kebab cap name is the lookup key. The camelCase `capKey` is
 *  the tRPC client router key; `field` is the numeric field on that cap's
 *  status; `fallbackUnit` is used when the status omits a `unit`. */
export interface SensorMapping {
  readonly capKey: string
  readonly field: string
  readonly fallbackUnit?: string
}

/** Kebab sensor cap → its numeric-value mapping. `enum-sensor` is handled
 *  separately by callers (it reads a raw string `value`, not a numeric field),
 *  so it intentionally has no entry here. */
export const SENSOR_MAP: Readonly<Record<string, SensorMapping>> = {
  'temperature-sensor': { capKey: 'temperatureSensor', field: 'celsius', fallbackUnit: '°C' },
  'humidity-sensor': { capKey: 'humiditySensor', field: 'percent', fallbackUnit: '%' },
  'ambient-light-sensor': { capKey: 'ambientLightSensor', field: 'lux', fallbackUnit: 'lx' },
  'numeric-sensor': { capKey: 'numericSensor', field: 'value' },
}

// ── tRPC client-proxy callable guard (#24) ───────────────────────────────────

/** True when a value is a navigable node: a plain object OR a tRPC v11 client
 *  proxy node (a callable `Proxy(noop)` → `typeof === 'function'`, NOT an
 *  object). A `typeof === 'object'`-only check REJECTS every real client proxy,
 *  so `resolveMutate` would return null and EVERY control becomes a silent
 *  no-op. Framework-free: operates on the SDK proxy shape only. */
export function isNode(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** Resolve `router.<method>.mutate` to a callable, or `null`. Walks the tRPC
 *  client proxy defensively (each hop guarded by `isNode`). */
export function resolveMutate(
  router: unknown,
  method: string,
): ((input: Record<string, unknown>) => Promise<unknown>) | null {
  if (!isNode(router)) return null
  const proc = router[method]
  if (!isNode(proc)) return null
  const mutate = proc.mutate
  return typeof mutate === 'function'
    ? (mutate as (input: Record<string, unknown>) => Promise<unknown>)
    : null
}
