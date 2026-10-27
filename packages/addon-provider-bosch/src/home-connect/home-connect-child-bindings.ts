import { z } from 'zod'
import type {
  BinaryStatus,
  EnumSensorStatus,
  NumericSensorStatus,
  PowerMeterStatus,
} from '@camstack/types'
import { DeviceRole, ingestReading, quantityFromUnit } from '@camstack/types'
import type {
  HomeConnectDescriptionStore,
  HomeConnectEntityView,
} from './home-connect-description-store.js'
import { eventActive } from './home-connect-domain-mapping.js'
import { energyToKwh, featureShortName, isEnergyUnit, resolveUnit } from './home-connect-units.js'
import { HOME_CONNECT_INFO_PREFIX, HOME_CONNECT_NETWORK_PREFIX } from './home-connect-ws-client.js'

/** The capability a bound child registers. */
export const HomeConnectChildCapSchema = z.enum([
  'numeric-sensor',
  'power-meter',
  'enum-sensor',
  'binary',
])
export type HomeConnectChildCap = z.infer<typeof HomeConnectChildCapSchema>

/** How the raw value becomes the slice value. */
export const HomeConnectChildConvertSchema = z.enum(['none', 'energy-total-kwh', 'event-active'])
export type HomeConnectChildConvert = z.infer<typeof HomeConnectChildConvertSchema>

/**
 * One appliance entity exposed as one child device. Persisted on the container, so a
 * child's identity (`stableIdSuffix`) survives restarts and description reloads.
 */
export const HomeConnectChildBindingSchema = z.object({
  /** Stable, derived from the feature key — never from a uid, which differs per model. */
  stableIdSuffix: z.string().min(1),
  /** Feature key the child reads (`BSH.Common.Status.DoorState`, `HomeConnect.Network.rssi`). */
  key: z.string().min(1),
  cap: HomeConnectChildCapSchema,
  convert: HomeConnectChildConvertSchema,
  role: z.enum(DeviceRole),
  /** Display name, without the appliance label. */
  name: z.string().min(1),
  /** Unit of an info field the description does not declare (`dBm` for a signal strength). */
  unit: z.string().min(1).optional(),
})
export type HomeConnectChildBinding = z.infer<typeof HomeConnectChildBindingSchema>

export function slugFeatureKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** `OperationState` -> `Operation state`. */
export function humanizeFeatureName(short: string): string {
  const spaced = short
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
  return spaced.length === 0
    ? short
    : spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

const FRIENDLY_NAMES: Readonly<Record<string, string>> = {
  StartInRelative: 'Delayed start',
  RemoteControlActive: 'Remote control active',
  RemoteControlStartAllowed: 'Remote start allowed',
  BackendConnected: 'Cloud connection',
  CloudConnected: 'Cloud connection',
}

/** Whether an entity is already carried whole by the dishwasher device and so is not a child. */
const NOT_A_CHILD_KINDS: ReadonlySet<string> = new Set([
  'command',
  'program',
  'activeProgram',
  'selectedProgram',
])

type ValueClass = 'numeric' | 'enum' | 'binary'

/** What an entity's values look like — from its description first, its current value second. */
function valueClassOf(entity: HomeConnectEntityView, current: unknown): ValueClass | null {
  if (entity.kind === 'event') return 'binary'
  if (entity.enumeration !== undefined || entity.valueType === 'enum') return 'enum'
  if (entity.valueType === 'number') return 'numeric'
  if (entity.valueType === 'boolean') return 'binary'
  if (typeof current === 'boolean') return 'binary'
  if (typeof current === 'number') return 'numeric'
  if (typeof current === 'string') return 'enum'
  return null
}

function roleFor(entity: HomeConnectEntityView, cls: ValueClass, unit: string | null): DeviceRole {
  if (cls === 'enum') return DeviceRole.EnumSensor
  if (cls === 'binary') {
    return entity.name.endsWith('Connected')
      ? DeviceRole.ConnectivitySensor
      : DeviceRole.BinarySensor
  }
  if (unit === '°C' || unit === '°F') return DeviceRole.TemperatureSensor
  return DeviceRole.NumericSensor
}

function isCumulativeEnergy(entity: HomeConnectEntityView): boolean {
  return (
    featureShortName(entity.name) === 'EnergyConsumption' && entity.name.includes('.Statistic.')
  )
}

/** A consumption entity is either the running total or the figure of one cycle — the name says which. */
function nameFor(entity: HomeConnectEntityView, short: string): string {
  if (short === 'EnergyConsumption' || short === 'WaterConsumption') {
    const what = short === 'EnergyConsumption' ? 'Energy used' : 'Water used'
    return entity.name.includes('.Statistic.') ? `${what} (total)` : `${what} (cycle)`
  }
  return FRIENDLY_NAMES[short] ?? humanizeFeatureName(short)
}

function bindingForEntity(
  entity: HomeConnectEntityView,
  current: unknown,
): HomeConnectChildBinding | null {
  if (NOT_A_CHILD_KINDS.has(entity.kind)) return null
  const cls = valueClassOf(entity, current)
  if (cls === null) return null
  const short = featureShortName(entity.name)
  const unit = cls === 'numeric' ? resolveUnit(entity) : null
  const name = nameFor(entity, short)
  const base = {
    stableIdSuffix: slugFeatureKey(entity.name),
    key: entity.name,
    name,
  }
  if (cls === 'binary') {
    return {
      ...base,
      cap: 'binary',
      convert: entity.kind === 'event' ? 'event-active' : 'none',
      role: roleFor(entity, cls, unit),
    }
  }
  if (cls === 'enum') {
    return {
      ...base,
      cap: 'enum-sensor',
      convert: 'none',
      role: roleFor(entity, cls, unit),
    }
  }
  // The cumulative energy counter is a meter ONLY when its unit is known to be an
  // energy unit; otherwise it is published raw and unitless rather than mislabelled.
  if (isCumulativeEnergy(entity) && isEnergyUnit(unit)) {
    return {
      ...base,
      name: 'Energy total',
      cap: 'power-meter',
      convert: 'energy-total-kwh',
      role: DeviceRole.EnergySensor,
    }
  }
  return {
    ...base,
    cap: 'numeric-sensor',
    convert: 'none',
    role: roleFor(entity, cls, unit),
  }
}

function infoLabel(key: string): string {
  const isNetwork = key.startsWith(HOME_CONNECT_NETWORK_PREFIX)
  const field = key.slice(
    (isNetwork ? HOME_CONNECT_NETWORK_PREFIX : HOME_CONNECT_INFO_PREFIX).length,
  )
  return `${isNetwork ? 'Network' : 'Appliance'} ${humanizeFeatureName(field).toLowerCase()}`
}

/** Info fields whose unit is part of the Home Connect interface (a Wi-Fi signal is dBm). */
const INFO_UNITS: Readonly<Record<string, string>> = { rssi: 'dBm' }

function bindingForInfo(key: string, current: unknown): HomeConnectChildBinding | null {
  const base = {
    stableIdSuffix: slugFeatureKey(key),
    key,
    name: infoLabel(key),
  }
  if (typeof current === 'number') {
    const unit = INFO_UNITS[key.split('.').pop() ?? '']
    return {
      ...base,
      cap: 'numeric-sensor',
      convert: 'none',
      role: DeviceRole.NumericSensor,
      ...(unit !== undefined ? { unit } : {}),
    }
  }
  if (typeof current === 'boolean') {
    return {
      ...base,
      cap: 'binary',
      convert: 'none',
      role: DeviceRole.BinarySensor,
    }
  }
  if (typeof current === 'string') {
    return {
      ...base,
      cap: 'enum-sensor',
      convert: 'none',
      role: DeviceRole.EnumSensor,
    }
  }
  return null
}

/**
 * Every entity of the appliance's description, plus the `/ci` and `/ni` fields it
 * sent, as child bindings. Nothing the appliance declares is dropped for not being
 * in a catalog: a friendlier name is all a catalog adds.
 *
 * An entity whose value type cannot be told from its description is bound once a
 * value shows it; until then it is absent (not guessed).
 */
export function deriveChildBindings(input: {
  readonly description: HomeConnectDescriptionStore
  readonly features: ReadonlyMap<string, unknown>
}): readonly HomeConnectChildBinding[] {
  const out = new Map<string, HomeConnectChildBinding>()
  for (const entity of input.description.entities()) {
    const binding = bindingForEntity(entity, input.features.get(entity.name))
    if (binding !== null) out.set(binding.stableIdSuffix, binding)
  }
  for (const [key, value] of input.features) {
    if (!key.startsWith(HOME_CONNECT_INFO_PREFIX) && !key.startsWith(HOME_CONNECT_NETWORK_PREFIX)) {
      continue
    }
    const binding = bindingForInfo(key, value)
    if (binding !== null) out.set(binding.stableIdSuffix, binding)
  }
  return [...out.values()].toSorted((a, b) => a.stableIdSuffix.localeCompare(b.stableIdSuffix))
}

// ---------------------------------------------------------------------------
// value -> slice
// ---------------------------------------------------------------------------

export type HomeConnectChildSlice =
  | { readonly cap: 'numeric-sensor'; readonly status: NumericSensorStatus }
  | { readonly cap: 'power-meter'; readonly status: PowerMeterStatus }
  | { readonly cap: 'enum-sensor'; readonly status: EnumSensorStatus }
  | { readonly cap: 'binary'; readonly status: BinaryStatus }

/**
 * The slice a child publishes for one raw value, or `null` when the value is not
 * known / not usable — in which case the child publishes NOTHING (it goes offline),
 * rather than a `0` / `false` / `unknown` that reads as a measurement.
 */
export function childSliceFromValue(input: {
  readonly binding: HomeConnectChildBinding
  readonly entity: HomeConnectEntityView | undefined
  readonly raw: unknown
  readonly nowMs: number
}): HomeConnectChildSlice | null {
  const { binding, raw, nowMs } = input
  if (raw === undefined || raw === null) return null
  switch (binding.cap) {
    case 'binary': {
      const on =
        binding.convert === 'event-active'
          ? eventActive(raw)
          : typeof raw === 'boolean'
            ? raw
            : null
      return on === null ? null : { cap: 'binary', status: { on, lastChangedAt: nowMs } }
    }
    case 'enum-sensor':
      return typeof raw === 'string' || typeof raw === 'number'
        ? {
            cap: 'enum-sensor',
            status: { value: String(raw), lastFetchedAt: nowMs },
          }
        : null
    case 'power-meter': {
      if (typeof raw !== 'number') return null
      const unit = input.entity === undefined ? null : resolveUnit(input.entity)
      const kwh = energyToKwh(raw, unit)
      return kwh === null
        ? null
        : {
            cap: 'power-meter',
            status: { energy: kwh, lastFetchedAt: nowMs },
          }
    }
    case 'numeric-sensor': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
      const unit = input.entity === undefined ? (binding.unit ?? null) : resolveUnit(input.entity)
      const quantity = unit === null ? 'none' : quantityFromUnit(unit)
      const stored =
        quantity === undefined || quantity === 'device'
          ? null
          : ingestReading({ value: raw, rawUnit: unit ?? undefined, quantity })
      const value = stored !== null && stored.ok ? stored.value : null
      return {
        cap: 'numeric-sensor',
        status: { value, lastFetchedAt: nowMs },
      }
    }
  }
}

// ---------------------------------------------------------------------------
// children persisted before the description-derived model
// ---------------------------------------------------------------------------

const LEGACY_CHILD_KEYS: Readonly<
  Record<
    string,
    {
      readonly key: string
      readonly cap: HomeConnectChildCap
      readonly role: DeviceRole
    }
  >
> = {
  'energy-forecast': {
    key: 'BSH.Common.Option.EnergyForecast',
    cap: 'numeric-sensor',
    role: DeviceRole.NumericSensor,
  },
  'water-forecast': {
    key: 'BSH.Common.Option.WaterForecast',
    cap: 'numeric-sensor',
    role: DeviceRole.NumericSensor,
  },
  'energy-consumed': {
    key: 'BSH.Common.Option.EnergyConsumption',
    cap: 'numeric-sensor',
    role: DeviceRole.NumericSensor,
  },
  'water-consumed': {
    key: 'BSH.Common.Option.WaterConsumption',
    cap: 'numeric-sensor',
    role: DeviceRole.NumericSensor,
  },
  'remote-control-level': {
    key: 'BSH.Common.Setting.RemoteControlLevel',
    cap: 'enum-sensor',
    role: DeviceRole.EnumSensor,
  },
  'delayed-start': {
    key: 'BSH.Common.Option.StartInRelative',
    cap: 'numeric-sensor',
    role: DeviceRole.NumericSensor,
  },
  'interior-light': {
    key: 'BSH.Common.Setting.AmbientLightEnabled',
    cap: 'binary',
    role: DeviceRole.BinarySensor,
  },
  connectivity: {
    key: 'BSH.Common.Status.BackendConnected',
    cap: 'binary',
    role: DeviceRole.ConnectivitySensor,
  },
  'program-phase': {
    key: 'Dishcare.Dishwasher.Status.ProgramPhase',
    cap: 'enum-sensor',
    role: DeviceRole.EnumSensor,
  },
}

/**
 * Keys the old fixed catalog guessed WRONG and persisted, mapped to the key the appliance really
 * lists. The remote-control level is a SETTING; the catalog filed it as a status, so a container
 * saved then carries `remote-control-level` on a key no description has, next to the derived
 * child the real key produced — one label, two devices.
 */
const SUPERSEDED_LEGACY_KEYS: Readonly<Record<string, string>> = {
  'BSH.Common.Status.RemoteControlLevel': 'BSH.Common.Setting.RemoteControlLevel',
}

/**
 * A persisted binding with a superseded legacy key re-pointed at the real one (same suffix, so
 * the same device); every other binding unchanged.
 */
export function withCurrentLegacyKey(binding: HomeConnectChildBinding): HomeConnectChildBinding {
  const current = SUPERSEDED_LEGACY_KEYS[binding.key]
  return current === undefined ? binding : { ...binding, key: current }
}

/** Whether a suffix is the one a key would derive — i.e. not an identity inherited from the old catalog. */
export function isDerivedSuffix(binding: HomeConnectChildBinding): boolean {
  return binding.stableIdSuffix === slugFeatureKey(binding.key)
}

/**
 * The bindings that keep a container's EXISTING children alive until its description has been
 * read once: a container saved with the old fixed `children` list has no `entities` yet, and a
 * spec without those children would make the kernel delete them (removal by absence) before any
 * replacement exists. They keep their stable suffix; the first successful derive replaces them.
 */
export function legacyChildBindings(children: unknown): readonly HomeConnectChildBinding[] {
  if (!Array.isArray(children)) return []
  const out: HomeConnectChildBinding[] = []
  for (const row of children) {
    if (typeof row !== 'object' || row === null) continue
    const suffix = Reflect.get(row, 'stableIdSuffix')
    const name = Reflect.get(row, 'name')
    if (typeof suffix !== 'string') continue
    const binding = legacyKindBinding(suffix, typeof name === 'string' ? name : '')
    if (binding !== null) out.push(binding)
  }
  return out
}

/**
 * The binding a child of the OLD fixed catalog stands for. Its kind is its stable suffix
 * (`energy-forecast`, `program-phase`, …); the child row it was persisted with carries that
 * kind as `sensorKind` and no `binding`. `null` for a kind the catalog never had.
 */
export function legacyKindBinding(kind: string, name: string): HomeConnectChildBinding | null {
  const known = LEGACY_CHILD_KEYS[kind]
  if (known === undefined) return null
  return {
    stableIdSuffix: kind,
    key: known.key,
    cap: known.cap,
    convert: 'none',
    role: known.role,
    name: name.length > 0 ? name : kind,
  }
}
