/**
 * SensorValueAtom — read-only badge for Sensor / Presence device rows.
 *
 * Renders a compact inline badge showing the device's current value:
 *  - typed numeric roles (temperature/humidity/ambient-light/pressure):
 *    value + canonical unit from ROLE_DESCRIPTOR (not sourceInfo)
 *  - generic numeric-sensor role: value + unit from the SLICE (populated
 *    live by the HA provider from state.attributes.unit_of_measurement)
 *  - binary roles: on/off label coloured per state
 *  - presence: Home / Away / zone name
 *
 * Returns null when no descriptor matches the role, or when the slice
 * has not yet landed (binding still resolving, or cap unbound).
 *
 * The proxy state is accessed via a typed per-role accessor stored in
 * `SensorDescriptor.getSliceHandle`. Each accessor is a concrete arrow
 * into the typed `DeviceProxy['state']` shape — no dynamic string
 * indexing. The shared handle type is `SliceHandle<unknown>` so the
 * discriminated union can hold all three descriptor kinds without casts
 * at the call site; narrowing occurs after `useDeviceStateSlice`.
 */
import type { ReactNode } from 'react'
import type { DeviceProxy, ReadingQuantity, SliceHandle } from '@camstack/types'
import {
  useDeviceProxy,
  useDeviceStateSlice,
  type UseDeviceProxyTrpc,
} from '../../hooks/use-device-proxy'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import {
  formatControlDateTime,
  type ControlDateTimeFormat,
} from '../../lib/format-control-datetime'
import { resolveSensorDisplay } from '../../lib/resolve-sensor-display'
import { useDeviceManagerGetRoleDisplayDefaults } from '../../generated/system-hooks'
import type { DeviceItemDevice } from '../device-item/helpers'

// ── Per-kind value shapes (structural, not imported) ──────────────────

interface NumericSliceValue {
  readonly [field: string]: number
}

interface BinarySliceValue {
  readonly [field: string]: boolean | number | null | undefined
}

interface PresenceSliceValue {
  readonly state: string
  readonly location: string | null
  readonly gps: unknown | null
  readonly lastChangedAt: number
}

// ── Descriptor shapes ─────────────────────────────────────────────────

interface NumericDescriptor {
  readonly kind: 'numeric'
  /** Field in the slice that holds the numeric value. */
  readonly field: string
  /** Quantity of the stored number. `device` reads `sourceInfo.quantity`. */
  readonly quantity?: ReadingQuantity
  /** Accessor into DeviceProxy['state'] — returns a typed slice handle. */
  readonly getSliceHandle: (state: DeviceProxy['state']) => SliceHandle<unknown>
}

interface BinaryDescriptor {
  readonly kind: 'binary'
  /** Field in the slice that holds the boolean trigger. */
  readonly field: string
  /** Label shown when the boolean field is truthy. */
  readonly onLabel: string
  /** Label shown when the boolean field is falsy. */
  readonly offLabel: string
  readonly getSliceHandle: (state: DeviceProxy['state']) => SliceHandle<unknown>
}

interface PresenceDescriptor {
  readonly kind: 'presence'
  readonly getSliceHandle: (state: DeviceProxy['state']) => SliceHandle<unknown>
}

/**
 * String-valued sensor whose slice holds `{ value: string, lastFetchedAt }`.
 * Used for HA free-text sensors (IP address, SSID, firmware version, …) that
 * have no numeric device_class and whose state is a plain string.
 */
interface StringDescriptor {
  readonly kind: 'string'
  readonly getSliceHandle: (state: DeviceProxy['state']) => SliceHandle<unknown>
}

/**
 * Date / timestamp sensor whose slice holds `{ value: string, format? }`
 * carrying a raw ISO string (e.g. '2025-12-02T09:36:12+00:00'). Rendered
 * locale-formatted via `formatControlDateTime`. The slice's own `format` (seeded
 * by the HA provider from the entity's `device_class` — `timestamp` → 'datetime',
 * `date` → 'date', time-only → 'time') selects the shape; `descriptor.format` is
 * the fallback for slices adopted before the field was threaded ('datetime').
 */
interface DateTimeDescriptor {
  readonly kind: 'datetime'
  readonly format: ControlDateTimeFormat
  readonly getSliceHandle: (state: DeviceProxy['state']) => SliceHandle<unknown>
}

export type SensorDescriptor =
  | NumericDescriptor
  | BinaryDescriptor
  | PresenceDescriptor
  | StringDescriptor
  | DateTimeDescriptor

/**
 * Binary fallback for the `battery-sensor` role.
 *
 * HA assigns role `battery-sensor` to BOTH numeric battery entities
 * (`sensor.*` device_class=battery → cap `numeric-sensor`) AND binary battery
 * entities (`binary_sensor.*` device_class=battery → cap `binary`, e.g. a
 * HomeMatic `LOW_BAT` flag). When the numeric slice is absent the binary slice
 * is rendered instead, with battery-specific polarity: `on:true` means LOW
 * (bad → warning style + "Low"), `on:false` means Normal (neutral).
 */
export const BINARY_BATTERY_DESCRIPTOR: BinaryDescriptor = {
  kind: 'binary',
  field: 'on',
  onLabel: 'Low',
  offLabel: 'Normal',
  getSliceHandle: (s) => s.binary,
}

/** True for the role that can resolve to either a numeric or a binary slice. */
export function isBatterySensorRole(role: string | null | undefined): boolean {
  return role === 'battery-sensor'
}

/**
 * A numeric slice counts as "present" only when it carries a real numeric value
 * at the descriptor field — a cold-start slice (`{ value: 0, lastFetchedAt: 0 }`)
 * or a binary slice (no numeric field) does NOT, so the binary fallback wins.
 */
export function hasBatteryNumericValue(slice: unknown, field: string): boolean {
  if (!isNumericSliceValue(slice)) return false
  const rawValue = (slice as Record<string, unknown>)[field]
  if (typeof rawValue !== 'number') return false
  const rawLastFetchedAt = (slice as Record<string, unknown>)['lastFetchedAt']
  return !(rawValue === 0 && rawLastFetchedAt === 0)
}

// ── Role descriptor registry ──────────────────────────────────────────

/**
 * Keyed by DeviceRole string value. Every entry maps a role to the
 * exact proxy state accessor + rendering instructions. The accessor
 * avoids dynamic string indexing — each one is a concrete property
 * access on the typed `DeviceProxy['state']` shape.
 *
 * The unit comes from the descriptor's quantity through `resolveSensorDisplay`.
 * A generic numeric sensor uses quantity `device` and the device's
 * `sourceInfo.quantity`.
 */
export const ROLE_DESCRIPTOR: Record<string, SensorDescriptor> = {
  // ── Numeric sensors ──────────────────────────────────────────────────
  'temperature-sensor': {
    kind: 'numeric',
    field: 'temperature',
    quantity: 'temperature',
    getSliceHandle: (s) => s.temperatureSensor,
  },
  'humidity-sensor': {
    kind: 'numeric',
    field: 'humidity',
    quantity: 'humidity',
    getSliceHandle: (s) => s.humiditySensor,
  },
  'ambient-light-sensor': {
    kind: 'numeric',
    field: 'illuminance',
    quantity: 'illuminance',
    getSliceHandle: (s) => s.ambientLightSensor,
  },
  'pressure-sensor': {
    kind: 'numeric',
    field: 'pressure',
    quantity: 'pressure',
    getSliceHandle: (s) => s.pressureSensor,
  },
  'numeric-sensor': {
    kind: 'numeric',
    field: 'value',
    quantity: 'device',
    getSliceHandle: (s) => s.numericSensor,
  },
  // ── Weather roles (wind/rain/uv/solar/soil) ──────────────────────────
  // Providers (Ecowitt, HA) emit these on the generic `numeric-sensor` cap
  // with a TYPED role for the icon/label — so the value descriptor is the same
  // as the generic numeric sensor (value + unit from the slice). Without these
  // entries SensorValueAtom returned null and the readings stayed invisible.
  'wind-sensor': {
    kind: 'numeric',
    field: 'value',
    quantity: 'device',
    getSliceHandle: (s) => s.numericSensor,
  },
  'rain-sensor': {
    kind: 'numeric',
    field: 'value',
    quantity: 'device',
    getSliceHandle: (s) => s.numericSensor,
  },
  'uv-sensor': {
    kind: 'numeric',
    field: 'value',
    quantity: 'device',
    getSliceHandle: (s) => s.numericSensor,
  },
  'solar-radiation-sensor': {
    kind: 'numeric',
    field: 'value',
    quantity: 'device',
    getSliceHandle: (s) => s.numericSensor,
  },
  'soil-moisture-sensor': {
    kind: 'numeric',
    field: 'value',
    quantity: 'device',
    getSliceHandle: (s) => s.numericSensor,
  },
  'power-sensor': {
    kind: 'numeric',
    field: 'power',
    quantity: 'power',
    getSliceHandle: (s) => s.powerMeter,
  },
  'energy-sensor': {
    kind: 'numeric',
    field: 'energy',
    quantity: 'energy',
    getSliceHandle: (s) => s.powerMeter,
  },
  'voltage-sensor': {
    kind: 'numeric',
    field: 'voltage',
    quantity: 'voltage',
    getSliceHandle: (s) => s.powerMeter,
  },
  'current-sensor': {
    kind: 'numeric',
    field: 'current',
    quantity: 'current',
    getSliceHandle: (s) => s.powerMeter,
  },
  'battery-sensor': {
    kind: 'numeric',
    field: 'value',
    quantity: 'percentage',
    getSliceHandle: (s) => s.numericSensor,
  },
  'generic-sensor': {
    kind: 'numeric',
    field: 'value',
    quantity: 'device',
    getSliceHandle: (s) => s.numericSensor,
  },

  // ── Binary sensors ───────────────────────────────────────────────────
  'motion-sensor': {
    kind: 'binary',
    field: 'detected',
    onLabel: 'Detected',
    offLabel: 'Clear',
    getSliceHandle: (s) => s.motion,
  },
  'pir-sensor': {
    kind: 'binary',
    field: 'detected',
    onLabel: 'Detected',
    offLabel: 'Clear',
    getSliceHandle: (s) => s.motion,
  },
  'contact-sensor': {
    kind: 'binary',
    field: 'entryOpen',
    onLabel: 'Open',
    offLabel: 'Closed',
    getSliceHandle: (s) => s.contact,
  },
  'smoke-sensor': {
    kind: 'binary',
    field: 'detected',
    onLabel: 'Smoke!',
    offLabel: 'Clear',
    getSliceHandle: (s) => s.smoke,
  },
  'leak-sensor': {
    kind: 'binary',
    field: 'flooded',
    onLabel: 'Leak!',
    offLabel: 'Dry',
    getSliceHandle: (s) => s.flood,
  },
  'co-sensor': {
    kind: 'binary',
    field: 'detected',
    onLabel: 'CO!',
    offLabel: 'Clear',
    getSliceHandle: (s) => s.carbonMonoxide,
  },
  'binary-sensor': {
    kind: 'binary',
    field: 'on',
    onLabel: 'On',
    offLabel: 'Off',
    getSliceHandle: (s) => s.binary,
  },

  // ── Presence ─────────────────────────────────────────────────────────
  presence: {
    kind: 'presence',
    getSliceHandle: (s) => s.presence,
  },

  // ── String / enum sensor ─────────────────────────────────────────────
  // HA free-text sensors (IP address, SSID, firmware version, status text,
  // …) with no numeric device_class — slice holds { value: string }.
  'enum-sensor': {
    kind: 'string',
    getSliceHandle: (s) => s.enumSensor,
  },

  // ── Date / timestamp sensor ──────────────────────────────────────────
  // HA `sensor.*` with device_class `timestamp` (or `date`) — slice holds the
  // raw ISO string on the enum-sensor cap; rendered locale-formatted. Defaults
  // to the full datetime shape (the common case: cleaning date, last-seen, …).
  'datetime-sensor': {
    kind: 'datetime',
    format: 'datetime',
    getSliceHandle: (s) => s.enumSensor,
  },
}

// ── Type guards ───────────────────────────────────────────────────────

function isNumericSliceValue(v: unknown): v is NumericSliceValue {
  return typeof v === 'object' && v !== null
}

function isBinarySliceValue(v: unknown): v is BinarySliceValue {
  return typeof v === 'object' && v !== null
}

function isPresenceSliceValue(v: unknown): v is PresenceSliceValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    'state' in v &&
    typeof (v as Record<string, unknown>)['state'] === 'string'
  )
}

export interface StringSliceValue {
  readonly value: string
}

export function isStringSliceValue(v: unknown): v is StringSliceValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    'value' in v &&
    typeof (v as Record<string, unknown>)['value'] === 'string'
  )
}

/**
 * The enum-sensor slice carries an optional `format` ('date' | 'time' |
 * 'datetime') for `DateTimeSensor`-role sensors. Read it off the live slice so
 * each sensor renders its true shape; returns `undefined` when absent (older
 * adoptions) so the caller falls back to the descriptor default.
 */
export function readSliceDateTimeFormat(slice: unknown): ControlDateTimeFormat | undefined {
  if (typeof slice !== 'object' || slice === null) return undefined
  const raw = (slice as Record<string, unknown>)['format']
  if (raw === 'date' || raw === 'time' || raw === 'datetime') return raw
  return undefined
}

// ── Rendering helpers ─────────────────────────────────────────────────

function renderPresenceLabel(state: string, t: UiTextFn): string {
  if (state === 'home') return t('uiLibrary.sensor.presence.home', 'Home')
  if (state === 'not_home') return t('uiLibrary.sensor.presence.away', 'Away')
  return state.charAt(0).toUpperCase() + state.slice(1)
}

// ── Props ─────────────────────────────────────────────────────────────

export interface SensorValueAtomProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly device: DeviceItemDevice
}

// ── Component ─────────────────────────────────────────────────────────

export function SensorValueAtom({ trpc, device }: SensorValueAtomProps): ReactNode {
  const t = useUiText()
  const roleDescriptor = device.role != null ? ROLE_DESCRIPTOR[device.role] : undefined
  const isBattery = isBatterySensorRole(device.role)
  // Per-role display defaults merge UNDER any per-device `display` override.
  // React-Query dedupes this across every row on one key; `undefined` (query
  // not yet landed) degrades to device-override-only with no flash of wrong
  // data since role defaults sit under the device override.
  const { data: roleDefaultsData } = useDeviceManagerGetRoleDisplayDefaults(
    {},
    { staleTime: 60_000 },
  )

  const dev = useDeviceProxy(trpc, device.id)
  const handle: SliceHandle<unknown> | undefined =
    dev !== null && roleDescriptor !== undefined
      ? roleDescriptor.getSliceHandle(dev.state)
      : undefined
  const numericSlice = useDeviceStateSlice(handle)

  // String fallback: numeric-sensor devices that were adopted before the
  // domain-mapping fix may carry string states (IP, SSID, firmware version).
  // HaNumericSensorDevice registers a companion enum-sensor cap that stores
  // the raw string. When the numeric slice is at cold-start (lastFetchedAt=0),
  // check the enum-sensor slice and show the string if available.
  // useDeviceStateSlice must be called unconditionally (React hook rule).
  const enumSensorHandle: SliceHandle<unknown> | undefined =
    dev !== null && roleDescriptor?.kind === 'numeric' ? dev.state.enumSensor : undefined
  const enumSensorSlice = useDeviceStateSlice(enumSensorHandle)

  // Binary battery fallback: the `battery-sensor` role maps to a numeric slice
  // for `sensor.*` entities but to a binary slice for `binary_sensor.*` LOW_BAT
  // entities. Subscribe to the binary slice unconditionally (hook-safe — the
  // handle is undefined for every non-battery role, and useDeviceStateSlice
  // returns undefined for an undefined handle) and pick which slice wins below.
  const binaryBatteryHandle: SliceHandle<unknown> | undefined =
    dev !== null && isBattery ? dev.state.binary : undefined
  const binaryBatterySlice = useDeviceStateSlice(binaryBatteryHandle)

  // Effective descriptor + slice. For a battery sensor, prefer the numeric
  // percentage when a real numeric value landed; otherwise fall back to the
  // binary Normal/Low rendering. All other roles use the single role path.
  const useBinaryBattery =
    isBattery &&
    roleDescriptor?.kind === 'numeric' &&
    !hasBatteryNumericValue(numericSlice, roleDescriptor.field) &&
    binaryBatterySlice !== undefined
  const descriptor: SensorDescriptor | undefined = useBinaryBattery
    ? BINARY_BATTERY_DESCRIPTOR
    : roleDescriptor
  const slice: unknown = useBinaryBattery ? binaryBatterySlice : numericSlice

  if (descriptor === undefined || slice === undefined) return null

  if (descriptor.kind === 'numeric') {
    if (!isNumericSliceValue(slice)) return null
    const rawValue = (slice as Record<string, unknown>)[descriptor.field]
    if (typeof rawValue !== 'number') return null

    // String fallback: if this numeric slice is at cold-start AND we have a
    // non-empty string value from the companion enum-sensor cap, render that
    // instead (handles already-adopted free-text sensors whose device_class
    // was null → wrongly mapped to numeric-sensor before the domain fix).
    const rawLastFetchedAt = (slice as Record<string, unknown>)['lastFetchedAt']
    const numericIsColStart = rawValue === 0 && rawLastFetchedAt === 0
    if (numericIsColStart && isStringSliceValue(enumSensorSlice) && enumSensorSlice.value !== '') {
      return (
        <span className={cn('inline-flex items-baseline text-xs text-foreground')}>
          {enumSensorSlice.value}
        </span>
      )
    }
    // Suppress cold-start 0 entirely — when lastFetchedAt is 0 the sensor
    // has never pushed a real value and showing "0" is misleading.
    if (numericIsColStart) return null

    const deviceQuantity = device.sourceInfo?.quantity
    const resolved = resolveSensorDisplay({
      display: device.display,
      capName: device.role === 'numeric-sensor' ? 'numeric-sensor' : undefined,
      roleDefault: device.role != null ? roleDefaultsData?.defaults[device.role] : undefined,
      quantity: descriptor.quantity ?? 'device',
      deviceQuantity: deviceQuantity === 'device' ? undefined : deviceQuantity,
    })
    const rendered = resolved.format(rawValue)
    const unit = rendered.unit
    const formatted = rendered.text
    return (
      <span
        className={cn('inline-flex items-baseline gap-0.5 tabular-nums text-xs text-foreground')}
      >
        <span>{formatted}</span>
        {unit && <span className="text-foreground-subtle">{unit}</span>}
      </span>
    )
  }

  if (descriptor.kind === 'binary') {
    if (!isBinarySliceValue(slice)) return null
    const rawValue = (slice as Record<string, unknown>)[descriptor.field]
    const active = Boolean(rawValue)
    const label = active ? descriptor.onLabel : descriptor.offLabel
    return (
      <span
        className={cn(
          'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
          active ? 'bg-warning/15 text-warning' : 'bg-surface-subtle text-foreground-subtle',
        )}
      >
        {label}
      </span>
    )
  }

  if (descriptor.kind === 'string') {
    if (!isStringSliceValue(slice)) return null
    // Hide the cold-start sentinel (empty string — slice not yet populated).
    if (slice.value === '') return null
    return (
      <span className={cn('inline-flex items-baseline text-xs text-foreground')}>
        {slice.value}
      </span>
    )
  }

  if (descriptor.kind === 'datetime') {
    if (!isStringSliceValue(slice)) return null
    // Hide the cold-start sentinel (empty string — slice not yet populated).
    if (slice.value === '') return null
    // Prefer the per-sensor format the provider seeded into the slice (date /
    // time / datetime); fall back to the descriptor default for older adoptions.
    const format =
      device.sourceInfo?.dateTimeShape ?? readSliceDateTimeFormat(slice) ?? descriptor.format
    // formatControlDateTime never throws and falls back to the raw value when
    // it cannot parse the ISO string.
    const formatted = formatControlDateTime(slice.value, format)
    return (
      <span className={cn('inline-flex items-baseline text-xs text-foreground')}>{formatted}</span>
    )
  }

  // presence
  if (!isPresenceSliceValue(slice)) return null
  const label = renderPresenceLabel(slice.state, t)
  const isHome = slice.state === 'home'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
        isHome ? 'bg-success/15 text-success' : 'bg-surface-subtle text-foreground-subtle',
      )}
    >
      {label}
    </span>
  )
}
