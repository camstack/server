/**
 * Zigbee2MQTT `exposes` → Dominevo caps. Generic by design: nothing here knows a vendor or a model,
 * only the standard expose names Zigbee2MQTT itself publishes (`temperature`, `occupancy`,
 * `water_leak`, a `light` / `switch` / `cover` / `lock` / `climate` expose with its features).
 *
 * One physical device is ONE Dominevo device. Its primary function (climate, light, cover, lock,
 * switch, else sensor) picks the device type; every reading becomes a cap of that device, never a
 * separate sensor. Power, energy, voltage and current fold into `power-meter`; CO2, VOC, PM2.5,
 * PM10 and AQI into `air-quality-sensor`. Diagnostic and config exposes (link quality, battery
 * voltage, …) feed nothing. The plan is plain data, persisted on the device, so a device restored
 * while the server is unreachable still registers its caps.
 */
import { DeviceRole, DeviceType } from '@dominevo/types'
import { z } from 'zod'
import type { Z2mExpose, Z2mScalar } from './z2m-protocol.js'

export const Z2M_CAPS = [
  'climate-control',
  'cover',
  'lock-control',
  'switch',
  'brightness',
  'color',
  'event-emitter',
  'contact',
  'motion',
  'flood',
  'smoke',
  'vibration',
  'tamper',
  'temperature-sensor',
  'humidity-sensor',
  'pressure-sensor',
  'ambient-light-sensor',
  'air-quality-sensor',
  'power-meter',
  'battery',
] as const
export const Z2mCapSchema = z.enum(Z2M_CAPS)
export type Z2mCap = z.infer<typeof Z2mCapSchema>

export const Z2mMeterFieldSchema = z.enum(['power', 'energy', 'voltage', 'current'])
export type Z2mMeterField = z.infer<typeof Z2mMeterFieldSchema>
export const Z2mAirFieldSchema = z.enum(['co2', 'voc', 'pm25', 'pm10', 'aqi'])
export type Z2mAirField = z.infer<typeof Z2mAirFieldSchema>

const ScalarSchema = z.union([z.boolean(), z.string(), z.number()])
const OnOffSchema = z.object({ on: ScalarSchema, off: ScalarSchema })

export const Z2mPlanSchema = z.object({
  deviceType: z.enum(DeviceType),
  capabilities: z.array(Z2mCapSchema),
  /** Cap (or `cover-position`, `cover-tilt`, `setpoint`, `current-temperature`, `system-mode`) → state property. */
  props: z.record(z.string(), z.string()),
  /** The exposed unit of a property, when it has one. */
  units: z.record(z.string(), z.string()),
  /** Binary cap → the values meaning active / inactive (`switch`, `lock-control` included). */
  binary: z.record(z.string(), OnOffSchema),
  meter: z.partialRecord(Z2mMeterFieldSchema, z.string()),
  air: z.partialRecord(Z2mAirFieldSchema, z.string()),
  /** Light range: the device's own brightness scale and colour-temperature span (mireds). */
  range: z.object({
    brightnessMax: z.number().nullable(),
    colorTempMin: z.number().nullable(),
    colorTempMax: z.number().nullable(),
  }),
  climate: z.object({
    modes: z.array(z.string()),
    min: z.number().nullable(),
    max: z.number().nullable(),
    step: z.number().nullable(),
  }),
  /** Cover capabilities: whether `position` and `tilt` exist. */
  cover: z.object({ positionable: z.boolean(), tilt: z.boolean() }),
  /** What the `action` property of a button can announce. */
  actions: z.array(z.string()),
  /** Exposes that feed nothing, with the reason (for the raw-state view). */
  skipped: z.array(z.object({ property: z.string(), reason: z.string() })),
})
export type Z2mPlan = z.infer<typeof Z2mPlanSchema>

type Props = Record<string, string>
type Units = Record<string, string>

const METER_BY_NAME: Readonly<Record<string, Z2mMeterField>> = {
  power: 'power',
  energy: 'energy',
  voltage: 'voltage',
  current: 'current',
}

const AIR_BY_NAME: Readonly<Record<string, Z2mAirField>> = {
  co2: 'co2',
  voc: 'voc',
  pm25: 'pm25',
  pm10: 'pm10',
  aqi: 'aqi',
}

const NUMERIC_CAP_BY_NAME: Readonly<Record<string, Z2mCap>> = {
  temperature: 'temperature-sensor',
  humidity: 'humidity-sensor',
  pressure: 'pressure-sensor',
  illuminance: 'ambient-light-sensor',
  illuminance_lux: 'ambient-light-sensor',
  battery: 'battery',
}

const BINARY_CAP_BY_NAME: Readonly<Record<string, Z2mCap>> = {
  occupancy: 'motion',
  presence: 'motion',
  motion: 'motion',
  contact: 'contact',
  water_leak: 'flood',
  smoke: 'smoke',
  vibration: 'vibration',
  tamper: 'tamper',
}

const SPECIFIC_TYPES: ReadonlySet<string> = new Set([
  'climate',
  'light',
  'cover',
  'lock',
  'switch',
  'fan',
])

/** A property that can be read from state: published (bit 1). An expose with no access is taken as published. */
function published(expose: Z2mExpose): boolean {
  return expose.access === undefined || (expose.access & 1) !== 0
}

function settable(expose: Z2mExpose): boolean {
  return expose.access !== undefined && (expose.access & 2) !== 0
}

function propertyOf(expose: Z2mExpose): string | null {
  return expose.property ?? expose.name ?? null
}

function featureNamed(parent: Z2mExpose, name: string): Z2mExpose | null {
  return (parent.features ?? []).find((f) => f.name === name || f.property === name) ?? null
}

function onOffOf(expose: Z2mExpose): { on: Z2mScalar; off: Z2mScalar } {
  return { on: expose.value_on ?? true, off: expose.value_off ?? false }
}

interface Draft {
  deviceType: DeviceType | null
  readonly caps: Set<Z2mCap>
  readonly props: Props
  readonly units: Units
  readonly binary: Record<string, { on: Z2mScalar; off: Z2mScalar }>
  readonly meter: Partial<Record<Z2mMeterField, string>>
  readonly air: Partial<Record<Z2mAirField, string>>
  range: Z2mPlan['range']
  climate: Z2mPlan['climate']
  cover: Z2mPlan['cover']
  actions: string[]
  readonly skipped: { property: string; reason: string }[]
}

function newDraft(): Draft {
  return {
    deviceType: null,
    caps: new Set(),
    props: {},
    units: {},
    binary: {},
    meter: {},
    air: {},
    range: { brightnessMax: null, colorTempMin: null, colorTempMax: null },
    climate: { modes: [], min: null, max: null, step: null },
    cover: { positionable: false, tilt: false },
    actions: [],
    skipped: [],
  }
}

function setProp(draft: Draft, key: string, expose: Z2mExpose): boolean {
  const property = propertyOf(expose)
  if (property === null || key in draft.props) return false
  draft.props[key] = property
  if (expose.unit !== undefined) draft.units[property] = expose.unit
  return true
}

function planLight(draft: Draft, light: Z2mExpose): void {
  const state = featureNamed(light, 'state')
  if (state === null || !setProp(draft, 'switch', state)) return
  draft.caps.add('switch')
  draft.binary['switch'] = onOffOf(state)
  const brightness = featureNamed(light, 'brightness')
  if (brightness !== null && settable(brightness) && setProp(draft, 'brightness', brightness)) {
    draft.caps.add('brightness')
    draft.range.brightnessMax = brightness.value_max ?? 254
  }
  const colorTemp = featureNamed(light, 'color_temp')
  if (colorTemp !== null && settable(colorTemp) && setProp(draft, 'color', colorTemp)) {
    draft.caps.add('color')
    draft.range.colorTempMin = colorTemp.value_min ?? null
    draft.range.colorTempMax = colorTemp.value_max ?? null
  }
}

function planSwitch(draft: Draft, sw: Z2mExpose): void {
  const state = featureNamed(sw, 'state')
  if (state === null || !setProp(draft, 'switch', state)) return
  draft.caps.add('switch')
  draft.binary['switch'] = onOffOf(state)
}

function planCover(draft: Draft, cover: Z2mExpose): void {
  const state = featureNamed(cover, 'state')
  if (state !== null && setProp(draft, 'cover-state', state)) draft.caps.add('cover')
  const position = featureNamed(cover, 'position')
  if (position !== null && setProp(draft, 'cover-position', position)) {
    draft.caps.add('cover')
    draft.cover.positionable = settable(position)
  }
  const tilt = featureNamed(cover, 'tilt')
  if (tilt !== null && setProp(draft, 'cover-tilt', tilt)) draft.cover.tilt = settable(tilt)
}

function planLock(draft: Draft, lock: Z2mExpose): void {
  const state = featureNamed(lock, 'state')
  if (state === null || !setProp(draft, 'lock-control', state)) return
  draft.caps.add('lock-control')
  draft.binary['lock-control'] = {
    on: state.value_on ?? 'LOCK',
    off: state.value_off ?? 'UNLOCK',
  }
  const lockState = featureNamed(lock, 'lock_state')
  if (lockState !== null) setProp(draft, 'lock-state', lockState)
}

function planClimate(draft: Draft, climate: Z2mExpose): void {
  const setpoint =
    featureNamed(climate, 'occupied_heating_setpoint') ??
    featureNamed(climate, 'current_heating_setpoint') ??
    featureNamed(climate, 'occupied_cooling_setpoint')
  const current = featureNamed(climate, 'local_temperature')
  const mode = featureNamed(climate, 'system_mode')
  if (setpoint === null && current === null && mode === null) return
  draft.caps.add('climate-control')
  if (setpoint !== null) {
    setProp(draft, 'setpoint', setpoint)
    draft.climate.min = setpoint.value_min ?? null
    draft.climate.max = setpoint.value_max ?? null
    draft.climate.step = setpoint.value_step ?? null
  }
  if (current !== null) setProp(draft, 'current-temperature', current)
  if (mode !== null) {
    setProp(draft, 'system-mode', mode)
    draft.climate.modes = mode.values ?? []
  }
}

function planGeneric(draft: Draft, expose: Z2mExpose): void {
  const property = propertyOf(expose)
  const name = expose.name ?? property
  if (property === null || name === null) return
  if (name === 'action' && expose.type === 'enum') {
    draft.actions = expose.values ?? []
    draft.caps.add('event-emitter')
    draft.props['event-emitter'] = property
    return
  }
  if (!published(expose)) return
  if (expose.type === 'numeric') {
    // Battery stays whatever its category says: it is the one diagnostic reading that is wanted.
    if (expose.category !== undefined && name !== 'battery') {
      draft.skipped.push({ property, reason: `${expose.category} expose` })
      return
    }
    const meter = METER_BY_NAME[name]
    if (meter !== undefined) {
      if (draft.meter[meter] === undefined) {
        draft.meter[meter] = property
        if (expose.unit !== undefined) draft.units[property] = expose.unit
        draft.caps.add('power-meter')
      }
      return
    }
    const air = AIR_BY_NAME[name]
    if (air !== undefined) {
      if (draft.air[air] === undefined) {
        draft.air[air] = property
        if (expose.unit !== undefined) draft.units[property] = expose.unit
        draft.caps.add('air-quality-sensor')
      }
      return
    }
    const cap = NUMERIC_CAP_BY_NAME[name]
    if (cap !== undefined) {
      // Both `illuminance` and `illuminance_lux` may exist; the one in lux wins.
      const prior = draft.props[cap]
      if (prior !== undefined && draft.units[prior] === 'lx') return
      if (prior !== undefined && expose.unit !== 'lx') return
      draft.props[cap] = property
      if (expose.unit !== undefined) draft.units[property] = expose.unit
      draft.caps.add(cap)
      return
    }
  }
  if (expose.type === 'binary') {
    if (expose.category !== undefined) {
      draft.skipped.push({ property, reason: `${expose.category} expose` })
      return
    }
    const cap = BINARY_CAP_BY_NAME[name]
    if (cap !== undefined && !(cap in draft.props)) {
      draft.props[cap] = property
      draft.binary[cap] = onOffOf(expose)
      draft.caps.add(cap)
      return
    }
  }
  draft.skipped.push({
    property,
    reason: `no capability for ${expose.type} ${name}`,
  })
}

function primaryType(exposes: readonly Z2mExpose[], draft: Draft): DeviceType | null {
  const has = (type: string, cap: Z2mCap): boolean =>
    exposes.some((e) => e.type === type) && draft.caps.has(cap)
  if (has('climate', 'climate-control')) return DeviceType.Climate
  if (has('light', 'switch')) return DeviceType.Light
  if (has('cover', 'cover')) return DeviceType.Cover
  if (has('lock', 'lock-control')) return DeviceType.Lock
  if (has('switch', 'switch')) return DeviceType.Switch
  // A battery is a diagnostic of the device, not a function: a button with one is still a button.
  const readings = [...draft.caps].filter((c) => c !== 'event-emitter' && c !== 'battery')
  if (readings.length > 0) return DeviceType.Sensor
  return draft.caps.has('event-emitter') ? DeviceType.EventEmitter : null
}

/** Caps that stay when a device's primary function is not a sensor. */
const ALLOWED_ALONGSIDE: Readonly<Record<string, ReadonlySet<Z2mCap>>> = {
  [DeviceType.Climate]: new Set<Z2mCap>(['climate-control', 'battery', 'power-meter']),
  [DeviceType.Light]: new Set<Z2mCap>(['switch', 'brightness', 'color', 'power-meter']),
  [DeviceType.Cover]: new Set<Z2mCap>(['cover', 'battery']),
  [DeviceType.Lock]: new Set<Z2mCap>(['lock-control', 'battery']),
  [DeviceType.Switch]: new Set<Z2mCap>(['switch', 'power-meter', 'battery']),
  [DeviceType.EventEmitter]: new Set<Z2mCap>(['event-emitter', 'battery']),
}

const CAP_ORDER: readonly Z2mCap[] = Z2M_CAPS

/**
 * Plan one device from its exposes; null when nothing of it can be exposed (a coordinator, a device
 * that is still interviewing, one whose only function is a fan).
 */
export function planZ2mDevice(exposes: readonly Z2mExpose[]): Z2mPlan | null {
  const draft = newDraft()
  for (const expose of exposes) {
    switch (expose.type) {
      case 'light':
        planLight(draft, expose)
        break
      case 'switch':
        planSwitch(draft, expose)
        break
      case 'cover':
        planCover(draft, expose)
        break
      case 'lock':
        planLock(draft, expose)
        break
      case 'climate':
        planClimate(draft, expose)
        break
      case 'fan':
        draft.skipped.push({
          property: expose.name ?? 'fan',
          reason: 'fan is not mapped',
        })
        break
      default:
        if (!SPECIFIC_TYPES.has(expose.type)) planGeneric(draft, expose)
    }
  }
  const deviceType = primaryType(exposes, draft)
  if (deviceType === null) return null
  const allowed = ALLOWED_ALONGSIDE[deviceType]
  const capabilities = CAP_ORDER.filter(
    (cap) => draft.caps.has(cap) && (allowed === undefined || allowed.has(cap)),
  )
  if (capabilities.length === 0) return null
  const kept = new Set<string>(capabilities)
  return Z2mPlanSchema.parse({
    deviceType,
    capabilities,
    props: draft.props,
    units: draft.units,
    binary: Object.fromEntries(Object.entries(draft.binary).filter(([cap]) => kept.has(cap))),
    meter: kept.has('power-meter') ? draft.meter : {},
    air: kept.has('air-quality-sensor') ? draft.air : {},
    range: draft.range,
    climate: draft.climate,
    cover: draft.cover,
    actions: draft.actions,
    skipped: draft.skipped,
  })
}

/** Primary cap → the role it already names; a switch, light, cover, lock or climate has none. */
export function roleForPrimaryCap(cap: Z2mCap | undefined): DeviceRole | null {
  switch (cap) {
    case 'contact':
      return DeviceRole.ContactSensor
    case 'motion':
      return DeviceRole.MotionSensor
    case 'flood':
      return DeviceRole.LeakSensor
    case 'smoke':
      return DeviceRole.SmokeSensor
    case 'vibration':
      return DeviceRole.VibrationSensor
    case 'tamper':
      return DeviceRole.TamperSensor
    case 'temperature-sensor':
      return DeviceRole.TemperatureSensor
    case 'humidity-sensor':
      return DeviceRole.HumiditySensor
    case 'pressure-sensor':
      return DeviceRole.PressureSensor
    case 'ambient-light-sensor':
      return DeviceRole.AmbientLightSensor
    case 'air-quality-sensor':
      return DeviceRole.AirQualitySensor
    case 'battery':
      return DeviceRole.BatterySensor
    default:
      return null
  }
}
