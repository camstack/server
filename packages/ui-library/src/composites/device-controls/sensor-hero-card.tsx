/**
 * SensorHeroCard — large-format sensor value display for the device-detail
 * hero area.
 *
 * Renders:
 *  - Typed numeric sensors: value in `text-3xl font-semibold tabular-nums` +
 *    the unit `resolveSensorDisplay` derives from the quantity.
 *  - Generic numeric-sensor: the same formatter, with the device's quantity.
 *  - Binary sensors: coloured state badge ("Detected"/"Clear" etc.) — same
 *    labels and colours as SensorValueAtom's binary branch.
 *  - Presence: Home/Away/zone-name badge — same labels as SensorValueAtom.
 *  - All: sensor name label below the value.
 *
 * Unit resolution uses the same formatter as SensorValueAtom.
 */
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import type { DeviceDisplayOverride, DeviceProxy, SliceHandle, SourceInfo } from '@camstack/types'
import { useDeviceProxy, useDeviceStateSlice } from '../../hooks/use-device-proxy'
import {
  useDeviceManagerGetDevice,
  useDeviceManagerGetRoleDisplayDefaults,
  useDeviceStateGetSnapshot,
} from '../../generated/system-hooks'
import { cn } from '../../lib/cn'
import { formatControlDateTime } from '../../lib/format-control-datetime'
import { resolveSensorDisplay } from '../../lib/resolve-sensor-display'
import {
  ROLE_DESCRIPTOR,
  BINARY_BATTERY_DESCRIPTOR,
  isBatterySensorRole,
  hasBatteryNumericValue,
  readSliceDateTimeFormat,
  isStringSliceValue,
  type SensorDescriptor,
} from './sensor-value-atom'
import type { DeviceControlProps } from './control-registry'
import { resolveSensorHeroReading, ROLE_OUTPUT_CAP } from './sensor-hero-source'

// ── Internal slice-value type guards (same as sensor-value-atom) ─────────────

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
  readonly batteryPercent: number | null
  readonly lastChangedAt: number
}

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

// ── Rendering helpers ─────────────────────────────────────────────────────────

function renderPresenceLabel(state: string, t: UiTextFn): string {
  if (state === 'home') return t('uiLibrary.sensor.presence.home', 'Home')
  if (state === 'not_home') return t('uiLibrary.sensor.presence.away', 'Away')
  return state.charAt(0).toUpperCase() + state.slice(1)
}

// ── Battery level bar ────────────────────────────────────────────────────────

type BatteryBand = 'low' | 'medium' | 'high'

/** Exhaustive fill colour per charge band — build fails if a band is added. */
const BATTERY_BAND_FILL = {
  low: 'bg-danger',
  medium: 'bg-warning',
  high: 'bg-success',
} satisfies Record<BatteryBand, string>

function batteryBand(percent: number): BatteryBand {
  if (percent <= 20) return 'low'
  if (percent <= 50) return 'medium'
  return 'high'
}

interface BatteryBarProps {
  readonly percent: number
}

/** Horizontal battery level bar: width = clamped percent, colour by band. */
function BatteryBar({ percent }: BatteryBarProps): ReactNode {
  const clamped = Math.min(100, Math.max(0, percent))
  const band = batteryBand(clamped)
  return (
    <div
      data-testid="battery-bar"
      data-band={band}
      className="h-2 w-24 overflow-hidden rounded-full bg-border"
    >
      <div
        className={cn('h-full rounded-full transition-all', BATTERY_BAND_FILL[band])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

// ── Minimal device-row interface needed to resolve the descriptor ────────────

interface SensorDeviceRow {
  readonly id: number
  readonly stableId: string
  readonly addonId: string
  readonly type: string
  readonly name: string
  readonly online: boolean
  readonly disabled: boolean
  readonly parentDeviceId: number | null
  readonly role?: string | null
  /** Operator-authored per-device display override (mirrors `DeviceInfo.display`). */
  readonly display?: DeviceDisplayOverride
  readonly sourceInfo?: SourceInfo
}

// ── Inner display component (needs the device row resolved) ──────────────────

interface SensorHeroInnerProps {
  readonly trpc: DeviceControlProps['trpc']
  readonly device: SensorDeviceRow
}

function SensorHeroInner({ trpc, device }: SensorHeroInnerProps): ReactNode {
  const t = useUiText()
  // Role missing (e.g. composed Room before role was stamped): fall back to
  // temperature-sensor so a live celsius slice is not stuck on "Awaiting…".
  const roleDescriptor =
    device.role != null ? ROLE_DESCRIPTOR[device.role] : ROLE_DESCRIPTOR['temperature-sensor']
  const isBattery = isBatterySensorRole(device.role)
  // Per-role display defaults merge UNDER any per-device `display` override.
  const { data: roleDefaultsData } = useDeviceManagerGetRoleDisplayDefaults(
    {},
    { staleTime: 60_000 },
  )

  const dev = useDeviceProxy(trpc, device.id)
  const handle: SliceHandle<unknown> | undefined =
    dev !== null && roleDescriptor !== undefined
      ? roleDescriptor.getSliceHandle(dev.state as DeviceProxy['state'])
      : undefined
  const numericSlice = useDeviceStateSlice(handle)

  // Binary battery fallback: the `battery-sensor` role maps to a numeric slice
  // for `sensor.*` entities but to a binary slice for `binary_sensor.*` LOW_BAT
  // entities. Subscribe to the binary slice unconditionally (hook-safe — the
  // handle is undefined for every non-battery role) and pick which wins below.
  const binaryBatteryHandle: SliceHandle<unknown> | undefined =
    dev !== null && isBattery ? (dev.state as DeviceProxy['state']).binary : undefined
  const binaryBatterySlice = useDeviceStateSlice(binaryBatteryHandle)

  // Room / dual-cap sensors: occupancy rides on `binary` beside the numeric hero.
  const occupancyHandle: SliceHandle<unknown> | undefined =
    dev !== null && !isBattery ? (dev.state as DeviceProxy['state']).binary : undefined
  const occupancySlice = useDeviceStateSlice(occupancyHandle)

  // For a battery sensor, prefer the numeric percentage when a real numeric
  // value landed; otherwise fall back to the binary Normal/Low rendering. The
  // selection mirrors SensorValueAtom so the hero and the row never diverge.
  const useBinaryBattery =
    isBattery &&
    roleDescriptor?.kind === 'numeric' &&
    !hasBatteryNumericValue(numericSlice, roleDescriptor.field) &&
    binaryBatterySlice !== undefined
  const descriptor: SensorDescriptor | undefined = useBinaryBattery
    ? BINARY_BATTERY_DESCRIPTOR
    : roleDescriptor
  const liveSlice: unknown = useBinaryBattery ? binaryBatterySlice : numericSlice
  const snapshot = useDeviceStateGetSnapshot({ deviceId: device.id }, { staleTime: 5_000 })
  const capName = useBinaryBattery
    ? 'binary'
    : device.role != null
      ? ROLE_OUTPUT_CAP[device.role]
      : ROLE_OUTPUT_CAP['temperature-sensor']
  const snapshotStatus =
    snapshot.status === 'success' || snapshot.status === 'error' ? snapshot.status : 'pending'
  const resolution = resolveSensorHeroReading({
    addonId: device.addonId,
    role: device.role,
    descriptor,
    capName,
    live: liveSlice,
    snapshotStatus,
    snapshotCaps: snapshot.data,
  })

  if (resolution.kind === 'quiet') {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4 min-h-[96px]"
        data-testid="sensor-hero-quiet"
      >
        <span className="text-sm text-foreground-subtle">{device.name}</span>
      </div>
    )
  }

  const slice: unknown = resolution.kind === 'value' ? resolution.slice : undefined

  if (descriptor === undefined || slice === undefined) {
    // Nothing resolved yet — show a waiting state.
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4 min-h-[96px]">
        <span className="text-sm text-foreground-subtle">{device.name}</span>
        <span className="text-xs text-foreground-subtle italic">
          {t('uiLibrary.sensorHeroCard.awaiting', 'Awaiting state…')}
        </span>
      </div>
    )
  }

  if (descriptor.kind === 'numeric') {
    if (!isNumericSliceValue(slice)) return null
    const rawValue = (slice as Record<string, unknown>)[descriptor.field]
    if (typeof rawValue !== 'number') return null
    // Unit + precision + render-time conversion via the shared resolver — same
    // precedence as SensorValueAtom so the hero and the row never diverge
    // (device override → role default → live slice → canonical unit). Storage
    // stays in source units; precision applies AFTER conversion.
    const deviceQuantity = device.sourceInfo?.quantity
    const resolved = resolveSensorDisplay({
      display: device.display,
      capName: device.role === 'numeric-sensor' ? 'numeric-sensor' : undefined,
      roleDefault:
        device.role != null
          ? roleDefaultsData?.defaults?.[device.role]
          : roleDefaultsData?.defaults?.['temperature-sensor'],
      quantity: descriptor.quantity ?? 'device',
      deviceQuantity: deviceQuantity === 'device' ? undefined : deviceQuantity,
    })
    const rendered = resolved.format(rawValue)
    const unit = rendered.unit
    const formatted = rendered.text
    const occupancyOn =
      occupancySlice !== undefined &&
      isBinarySliceValue(occupancySlice) &&
      typeof (occupancySlice as Record<string, unknown>)['on'] === 'boolean'
        ? Boolean((occupancySlice as Record<string, unknown>)['on'])
        : null

    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-semibold tabular-nums text-foreground">{formatted}</span>
          {unit && <span className="text-base text-foreground-subtle">{unit}</span>}
        </div>
        {/* Battery readout gets a horizontal level bar tinted by charge band. */}
        {isBattery && <BatteryBar percent={rawValue} />}
        {occupancyOn !== null && (
          <span
            className={cn(
              'inline-flex items-center rounded px-2 py-0.5 text-xs font-medium',
              occupancyOn
                ? 'bg-warning/15 text-warning'
                : 'bg-surface-subtle text-foreground-subtle',
            )}
            data-testid="sensor-hero-occupancy"
          >
            {occupancyOn
              ? t('uiLibrary.sensorHeroCard.occupied', 'Occupied')
              : t('uiLibrary.sensorHeroCard.clear', 'Clear')}
          </span>
        )}
        <span className="text-sm text-foreground-subtle">{device.name}</span>
      </div>
    )
  }

  if (descriptor.kind === 'binary') {
    if (!isBinarySliceValue(slice)) return null
    const rawValue = (slice as Record<string, unknown>)[descriptor.field]
    const active = Boolean(rawValue)
    const label = active ? descriptor.onLabel : descriptor.offLabel

    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4">
        <span
          className={cn(
            'inline-flex items-center rounded px-3 py-1.5 text-lg font-semibold',
            active ? 'bg-warning/15 text-warning' : 'bg-surface-subtle text-foreground-subtle',
          )}
        >
          {label}
        </span>
        <span className="text-sm text-foreground-subtle">{device.name}</span>
      </div>
    )
  }

  if (descriptor.kind === 'datetime') {
    if (!isStringSliceValue(slice)) return null
    // Cold-start sentinel (empty string) — sensor hasn't pushed a value yet.
    if (slice.value === '') {
      return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4 min-h-[96px]">
          <span className="text-sm text-foreground-subtle">{device.name}</span>
          <span className="text-xs text-foreground-subtle italic">
            {t('uiLibrary.sensorHeroCard.awaiting', 'Awaiting state…')}
          </span>
        </div>
      )
    }
    // Prefer the per-sensor format the provider seeded into the slice (date /
    // time / datetime); fall back to the descriptor default for older adoptions.
    const format =
      device.sourceInfo?.dateTimeShape ?? readSliceDateTimeFormat(slice) ?? descriptor.format
    // formatControlDateTime never throws; falls back to the raw value if unparseable.
    const formatted = formatControlDateTime(slice.value, format)
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4">
        <span className="text-3xl font-semibold tabular-nums text-foreground">{formatted}</span>
        <span className="text-sm text-foreground-subtle">{device.name}</span>
      </div>
    )
  }

  if (descriptor.kind === 'string') {
    if (!isStringSliceValue(slice)) return null
    if (slice.value === '') return null
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4">
        <span className="text-xl font-semibold text-foreground">{slice.value}</span>
        <span className="text-sm text-foreground-subtle">{device.name}</span>
      </div>
    )
  }

  // Presence
  if (!isPresenceSliceValue(slice)) return null
  const label = renderPresenceLabel(slice.state, t)
  const isHome = slice.state === 'home'

  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4">
      <span
        className={cn(
          'inline-flex items-center rounded px-3 py-1.5 text-lg font-semibold',
          isHome ? 'bg-success/15 text-success' : 'bg-surface-subtle text-foreground-subtle',
        )}
      >
        {label}
      </span>
      <span className="text-sm text-foreground-subtle">{device.name}</span>
    </div>
  )
}

// ── Public component ─────────────────────────────────────────────────────────

/**
 * SensorHeroCard — full hero card for the device-detail area.
 *
 * Fetches the device row (name, role, sourceInfo) via React Query
 * (`deviceManager.getDevice`), then delegates rendering to the inner
 * component that reads the live state slice via the proxy.
 */
export function SensorHeroCard({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const { data } = useDeviceManagerGetDevice({ deviceId }, { staleTime: 60_000 })

  if (data === undefined) return null

  return <SensorHeroInner trpc={trpc} device={data as SensorDeviceRow} />
}
