/**
 * What a `climate-control` device is to Alexa (D874) — pure, so the discovery
 * shape, the slice mapping and the directive handlers share one definition.
 *
 *   `Alexa.ThermostatController` 3.1  targetSetpoint, lowerSetpoint /
 *                                     upperSetpoint (a device with a range),
 *                                     thermostatMode HEAT / COOL / AUTO / ECO /
 *                                     OFF
 *   `Alexa.TemperatureSensor`         the current temperature
 *   `Alexa.PowerController`           when the device can be turned off
 *   `Alexa.ModeController` Climate.Mode      only when the device has a mode
 *                                     Amazon's thermostat vocabulary lacks
 *                                     (dry, fan_only)
 *   `Alexa.ModeController` Climate.FanSpeed  the device's own fan modes
 *
 * Amazon's `thermostatMode` has no value for `dry` / `fan_only`, and a CUSTOM
 * mode is not a documented way to carry them: they travel through the
 * `Climate.Mode` ModeController, and `thermostatMode` is simply not reported
 * while the device is in one of them.
 *
 * Temperatures are Celsius throughout (the cap's contract); Alexa converts for
 * the account.
 */
import { ClimateControlStatusSchema, type HvacMode } from '@camstack/types'
import type { z } from 'zod'
import type { AlexaCapability, AlexaDisplayCategory, AlexaFriendlyName } from '../types.js'
import type { AdapterDescription, AdapterDevice, GenericProperty } from './types.js'

export const INSTANCE_MODE = 'Climate.Mode'
export const INSTANCE_FAN = 'Climate.FanSpeed'
export const MODE_PREFIX = 'Mode.'
export const FAN_PREFIX = 'Fan.'

/** Setpoint bounds when the device reports none (Home Assistant's own defaults). */
export const DEFAULT_MIN_TEMP = 7
export const DEFAULT_MAX_TEMP = 35
export const DEFAULT_TEMP_STEP = 0.5

const FEATURE_DUAL_SETPOINT = 'climate-dual-setpoint'
const ALEXA_ECO_PRESET = 'eco'
const SINGLE_SETPOINT_MODES: readonly HvacMode[] = ['heat', 'cool', 'auto', 'dry']
/** What TurnOn switches to, best first. */
const TURN_ON_PREFERENCE: readonly HvacMode[] = ['auto', 'heat_cool', 'cool', 'heat']

export type ThermostatMode = 'HEAT' | 'COOL' | 'AUTO' | 'ECO' | 'OFF'

const SliceShape = ClimateControlStatusSchema.pick({
  mode: true,
  availableModes: true,
  fanMode: true,
  availableFanModes: true,
  preset: true,
  availablePresets: true,
  target: true,
  targetHigh: true,
  targetLow: true,
  currentTemp: true,
  minTemp: true,
  maxTemp: true,
  tempStep: true,
})
export type ClimateSlice = z.infer<typeof SliceShape>

/** The slice fields the adapter reads, or null when the slice is not a climate one. */
export function readClimateSlice(slice: unknown): ClimateSlice | null {
  const parsed = SliceShape.safeParse(slice)
  return parsed.success ? parsed.data : null
}

export interface TemperatureBounds {
  readonly min: number
  readonly max: number
  readonly step: number
}

export function boundsOf(slice: ClimateSlice): TemperatureBounds {
  const min = slice.minTemp ?? DEFAULT_MIN_TEMP
  const max = slice.maxTemp ?? DEFAULT_MAX_TEMP
  const step = slice.tempStep ?? DEFAULT_TEMP_STEP
  return min < max
    ? { min, max, step }
    : {
        min: DEFAULT_MIN_TEMP,
        max: DEFAULT_MAX_TEMP,
        step: DEFAULT_TEMP_STEP,
      }
}

/** One decimal, the precision Alexa's own conversions keep. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Snap a setpoint to the device's step (anchored at its minimum), then clamp:
 * a maximum off the step grid (max 30.2, step 0.5) must not snap above itself.
 */
export function snapToStep(value: number, bounds: TemperatureBounds): number {
  const snapped = bounds.min + Math.round((value - bounds.min) / bounds.step) * bounds.step
  return round1(Math.min(bounds.max, Math.max(bounds.min, snapped)))
}

export function temperatureValue(celsius: number): { value: number; scale: 'CELSIUS' } {
  return { value: round1(celsius), scale: 'CELSIUS' }
}

// ── Capabilities the device supports ────────────────────────────────

function hasMode(slice: ClimateSlice | null, mode: HvacMode): boolean {
  return slice !== null && slice.availableModes.includes(mode)
}

/** Dual setpoints (a heat/cool range). */
export function supportsDual(slice: ClimateSlice | null, features: readonly string[]): boolean {
  return slice === null ? features.includes(FEATURE_DUAL_SETPOINT) : hasMode(slice, 'heat_cool')
}

/** A single setpoint (everything but a range-only device). */
export function supportsSingle(slice: ClimateSlice | null): boolean {
  return slice === null || slice.availableModes.length === 0
    ? true
    : slice.availableModes.some((m) => SINGLE_SETPOINT_MODES.includes(m))
}

/** The device's own name for its `eco` preset, if it has one. */
export function ecoPresetOf(slice: ClimateSlice | null): string | null {
  return slice?.availablePresets.find((p) => p.toLowerCase() === ALEXA_ECO_PRESET) ?? null
}

/** Amazon thermostat modes the device can be put in, in a stable order. */
export function supportedThermostatModes(slice: ClimateSlice | null): readonly ThermostatMode[] {
  if (slice === null || slice.availableModes.length === 0) return ['HEAT', 'COOL', 'AUTO', 'OFF']
  const out: ThermostatMode[] = []
  if (hasMode(slice, 'heat')) out.push('HEAT')
  if (hasMode(slice, 'cool')) out.push('COOL')
  if (hasMode(slice, 'auto') || hasMode(slice, 'heat_cool')) out.push('AUTO')
  if (ecoPresetOf(slice) !== null && out.length > 0) out.push('ECO')
  if (hasMode(slice, 'off')) out.push('OFF')
  return out
}

/** The HVAC mode TurnOn / leaving OFF switches to. */
export function onModeOf(slice: ClimateSlice): HvacMode | null {
  return TURN_ON_PREFERENCE.find((m) => hasMode(slice, m)) ?? null
}

export function canPowerOff(slice: ClimateSlice | null): boolean {
  return slice === null || slice.availableModes.length === 0 || hasMode(slice, 'off')
}

/** A device with a mode Amazon's thermostat vocabulary lacks. */
export function hasExtraModes(slice: ClimateSlice | null): boolean {
  return hasMode(slice, 'dry') || hasMode(slice, 'fan_only')
}

// ── Climate.Mode (ModeController) ───────────────────────────────────

const MODE_VALUE: Readonly<Record<Exclude<HvacMode, 'heat_cool'>, string>> = {
  heat: 'Mode.Heat',
  cool: 'Mode.Cool',
  auto: 'Mode.Auto',
  dry: 'Mode.Dry',
  fan_only: 'Mode.Fan',
  off: 'Mode.Off',
}

const MODE_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  'Mode.Heat': ['Riscaldamento', 'Heating'],
  'Mode.Cool': ['Raffrescamento', 'Cooling'],
  'Mode.Auto': ['Automatico', 'Auto'],
  'Mode.Dry': ['Deumidificazione', 'Dry'],
  'Mode.Fan': ['Ventilazione', 'Fan only'],
  'Mode.Off': ['Spento', 'Off'],
}

/** The ModeController value a HVAC mode reports as (a range is "auto"). */
export function modeValueOf(mode: HvacMode): string {
  return mode === 'heat_cool' ? MODE_VALUE.auto : MODE_VALUE[mode]
}

/** The HVAC mode a ModeController value asks for, among those the device has. */
export function hvacModeForValue(value: string, slice: ClimateSlice): HvacMode | null {
  if (value === MODE_VALUE.auto) {
    return hasMode(slice, 'auto') ? 'auto' : hasMode(slice, 'heat_cool') ? 'heat_cool' : null
  }
  const entry = Object.entries(MODE_VALUE).find(([, v]) => v === value)
  const mode = entry?.[0]
  if (mode === undefined) return null
  const candidate = SliceShape.shape.mode.safeParse(mode)
  return candidate.success && hasMode(slice, candidate.data) ? candidate.data : null
}

/** The ModeController values the device offers, in a stable order. */
function modeValuesOf(slice: ClimateSlice): readonly string[] {
  const values = (['heat', 'cool', 'auto', 'dry', 'fan_only', 'off'] as const)
    .filter((m) =>
      m === 'auto' ? hasMode(slice, 'auto') || hasMode(slice, 'heat_cool') : hasMode(slice, m),
    )
    .map((m) => MODE_VALUE[m])
  return values
}

function textNames(it: string, en: string): readonly AlexaFriendlyName[] {
  return [
    { '@type': 'text', value: { text: it, locale: 'it-IT' } },
    { '@type': 'text', value: { text: en, locale: 'en-US' } },
  ]
}

function modeCapability(slice: ClimateSlice): AlexaCapability | null {
  const values = modeValuesOf(slice)
  if (values.length < 2) return null
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ModeController',
    version: '3',
    instance: INSTANCE_MODE,
    capabilityResources: {
      friendlyNames: [
        { '@type': 'asset', value: { assetId: 'Alexa.Setting.Mode' } },
        ...textNames('Modalità', 'Mode'),
      ],
    },
    properties: { supported: [{ name: 'mode' }], proactivelyReported: true, retrievable: true },
    configuration: {
      ordered: false,
      supportedModes: values.map((value) => {
        const [it, en] = MODE_NAMES[value] ?? [value, value]
        return { value, modeResources: { friendlyNames: textNames(it, en) } }
      }),
    },
  }
}

// ── Climate.FanSpeed (ModeController) ───────────────────────────────

const FAN_ASSETS: Readonly<Record<string, string>> = {
  low: 'Alexa.Value.Low',
  medium: 'Alexa.Value.Medium',
  high: 'Alexa.Value.High',
}

const FAN_TEXTS: Readonly<Record<string, readonly [string, string]>> = {
  auto: ['Automatico', 'Auto'],
  quiet: ['Silenzioso', 'Quiet'],
  turbo: ['Turbo', 'Turbo'],
  on: ['Acceso', 'On'],
  off: ['Spento', 'Off'],
  middle: ['Medio', 'Medium'],
  mediumlow: ['Medio basso', 'Medium low'],
  mediumhigh: ['Medio alto', 'Medium high'],
  medium_low: ['Medio basso', 'Medium low'],
  medium_high: ['Medio alto', 'Medium high'],
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** The ModeController value of a vendor fan mode (`medium_high` -> `Fan.MediumHigh`). */
export function fanValueOf(fanMode: string): string | null {
  const words = fanMode.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0)
  return words.length === 0 ? null : `${FAN_PREFIX}${words.map(capitalize).join('')}`
}

/** The fan modes with a usable, unique value: `[value, deviceFanMode]`. */
export function fanModesOf(slice: ClimateSlice): ReadonlyArray<readonly [string, string]> {
  const seen = new Set<string>()
  const out: Array<readonly [string, string]> = []
  for (const fanMode of slice.availableFanModes) {
    const value = fanValueOf(fanMode)
    if (value === null || seen.has(value)) continue
    seen.add(value)
    out.push([value, fanMode])
  }
  return out
}

export function hasFanModes(slice: ClimateSlice | null): boolean {
  return slice !== null && fanModesOf(slice).length >= 2
}

function fanFriendlyNames(fanMode: string): readonly AlexaFriendlyName[] {
  const key = fanMode.toLowerCase()
  const asset = FAN_ASSETS[key]
  if (asset !== undefined) return [{ '@type': 'asset', value: { assetId: asset } }]
  const [it, en] = FAN_TEXTS[key] ?? [fanMode.replace(/_/g, ' '), fanMode.replace(/_/g, ' ')]
  return textNames(it, en)
}

function fanCapability(slice: ClimateSlice): AlexaCapability | null {
  const modes = fanModesOf(slice)
  if (modes.length < 2) return null
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ModeController',
    version: '3',
    instance: INSTANCE_FAN,
    capabilityResources: {
      friendlyNames: [
        { '@type': 'asset', value: { assetId: 'Alexa.Setting.FanSpeed' } },
        ...textNames('Velocità ventola', 'Fan speed'),
      ],
    },
    properties: { supported: [{ name: 'mode' }], proactivelyReported: true, retrievable: true },
    configuration: {
      ordered: false,
      supportedModes: modes.map(([value, fanMode]) => ({
        value,
        modeResources: { friendlyNames: fanFriendlyNames(fanMode) },
      })),
    },
  }
}

// ── Discovery ───────────────────────────────────────────────────────

function propertiesBlock(names: readonly string[]): NonNullable<AlexaCapability['properties']> {
  return {
    supported: names.map((name) => ({ name })),
    proactivelyReported: true,
    retrievable: true,
  }
}

function thermostatCapability(
  slice: ClimateSlice | null,
  modes: readonly ThermostatMode[],
  features: readonly string[],
): AlexaCapability {
  const names = [
    ...(supportsSingle(slice) ? ['targetSetpoint'] : []),
    ...(supportsDual(slice, features) ? ['lowerSetpoint', 'upperSetpoint'] : []),
    'thermostatMode',
  ]
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ThermostatController',
    version: '3.1',
    properties: propertiesBlock(names),
    configuration: { supportedModes: modes, supportsScheduling: false },
  }
}

/** A thermostat is a THERMOSTAT, any other climate device an air conditioner. */
export function climateCategoryFor(deviceType: string): AlexaDisplayCategory {
  return deviceType === 'thermostat' ? 'THERMOSTAT' : 'AIR_CONDITIONER'
}

export function describeClimate(device: AdapterDevice): AdapterDescription {
  const slice = readClimateSlice(device.slices['climate-control'])
  const modes = supportedThermostatModes(slice)
  if (modes.length === 0) {
    return {
      kind: 'skip',
      reason: 'climate: the device offers no mode Alexa has a thermostat value for',
    }
  }
  const extras: AlexaCapability[] = []
  if (slice !== null) {
    const mode = hasExtraModes(slice) ? modeCapability(slice) : null
    const fan = hasFanModes(slice) ? fanCapability(slice) : null
    if (mode !== null) extras.push(mode)
    if (fan !== null) extras.push(fan)
  }
  return {
    kind: 'publish',
    capabilities: [
      thermostatCapability(slice, modes, device.features),
      {
        type: 'AlexaInterface',
        interface: 'Alexa.TemperatureSensor',
        version: '3',
        properties: propertiesBlock(['temperature']),
      },
      ...(canPowerOff(slice)
        ? [
            {
              type: 'AlexaInterface' as const,
              interface: 'Alexa.PowerController',
              version: '3',
              properties: propertiesBlock(['powerState']),
            },
          ]
        : []),
      ...extras,
    ],
    category: climateCategoryFor(device.type),
  }
}

// ── State ───────────────────────────────────────────────────────────

/** Amazon's `thermostatMode` for the state, or null while in a mode it lacks. */
export function thermostatModeOf(slice: ClimateSlice): ThermostatMode | null {
  if (slice.mode === 'off') return 'OFF'
  const eco = ecoPresetOf(slice)
  if (eco !== null && slice.preset === eco) return 'ECO'
  switch (slice.mode) {
    case 'heat':
      return 'HEAT'
    case 'cool':
      return 'COOL'
    case 'auto':
    case 'heat_cool':
      return 'AUTO'
    default:
      return null
  }
}

export function climateProperties(slice: unknown): readonly GenericProperty[] {
  const s = readClimateSlice(slice)
  if (s === null) return []
  const out: GenericProperty[] = []
  const thermostat = (name: string, value: unknown): void => {
    out.push({ namespace: 'Alexa.ThermostatController', name, value })
  }
  const range = hasMode(s, 'heat_cool') && s.targetLow !== null && s.targetHigh !== null
  if (range && s.mode === 'heat_cool') {
    thermostat('lowerSetpoint', temperatureValue(s.targetLow ?? 0))
    thermostat('upperSetpoint', temperatureValue(s.targetHigh ?? 0))
  } else if (s.target !== null && supportsSingle(s)) {
    thermostat('targetSetpoint', temperatureValue(s.target))
  }
  const mode = thermostatModeOf(s)
  if (mode !== null) thermostat('thermostatMode', mode)
  if (s.currentTemp !== null) {
    out.push({
      namespace: 'Alexa.TemperatureSensor',
      name: 'temperature',
      value: temperatureValue(s.currentTemp),
    })
  }
  if (canPowerOff(s)) {
    out.push({
      namespace: 'Alexa.PowerController',
      name: 'powerState',
      value: s.mode === 'off' ? 'OFF' : 'ON',
    })
  }
  if (hasExtraModes(s) && modeValuesOf(s).length >= 2) {
    out.push({
      namespace: 'Alexa.ModeController',
      instance: INSTANCE_MODE,
      name: 'mode',
      value: modeValueOf(s.mode),
    })
  }
  const fan = fanValueOf(s.fanMode)
  if (hasFanModes(s) && fan !== null && fanModesOf(s).some(([value]) => value === fan)) {
    out.push({
      namespace: 'Alexa.ModeController',
      instance: INSTANCE_FAN,
      name: 'mode',
      value: fan,
    })
  }
  return out
}
