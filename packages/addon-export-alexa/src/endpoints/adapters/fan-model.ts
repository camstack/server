/**
 * What a `fan` device is to Alexa (D869) — pure, so the discovery shape, the
 * slice mapping and the directive handler share one definition.
 *
 *   power         → `Alexa.PowerController` (from the `switch` cap)
 *   speed         → `Alexa.RangeController` `Fan.Speed` 0–100 %, precision the
 *                   device's `percentageStep`
 *   oscillation   → `Alexa.ToggleController` `Fan.Oscillating`
 *   presets       → `Alexa.ModeController` `Fan.Preset`: the device's own
 *                   preset modes UNION the operator's custom presets
 *                   (`fan-presets`), one mode per distinct name. A native mode
 *                   wins a name both share; Amazon needs two or more modes, so
 *                   one mode alone publishes none.
 */
import { DeviceFeature, FanControlStatusSchema } from '@camstack/types'
import type { AlexaCapability, AlexaFriendlyName } from '../types.js'
import type { AdapterDescription, AdapterDevice, GenericProperty } from './types.js'

export const INSTANCE_SPEED = 'Fan.Speed'
export const INSTANCE_OSCILLATING = 'Fan.Oscillating'
export const INSTANCE_PRESET = 'Fan.Preset'
export const PRESET_VALUE_PREFIX = 'Preset.'
/** The `slices` key under which discovery hands the custom preset names. */
export const CUSTOM_PRESETS_KEY = 'fan-presets'
/** Amazon: a ModeController needs at least two modes. */
const MIN_MODES = 2
const MAX_NAME = 64

const FanSliceSchema = FanControlStatusSchema.omit({ lastChangedAt: true })
export type FanSlice = ReturnType<typeof FanSliceSchema.parse>

export function readFanSlice(slice: unknown): FanSlice | null {
  const parsed = FanSliceSchema.safeParse(slice)
  return parsed.success ? parsed.data : null
}

/** The custom preset names discovery read; anything else is none. */
export function customPresetNames(slices: Readonly<Record<string, unknown>>): readonly string[] {
  const raw = slices[CUSTOM_PRESETS_KEY]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): string[] => {
    const name: unknown =
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'name') : undefined
    return typeof name === 'string' && name.trim().length > 0 ? [name.trim()] : []
  })
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** The ModeController value of a preset name (`quiet night` -> `Preset.QuietNight`), or null. */
export function presetValueOf(name: string): string | null {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0)
  return words.length === 0 ? null : `${PRESET_VALUE_PREFIX}${words.map(capitalize).join('')}`
}

export interface PresetMode {
  readonly value: string
  readonly name: string
  readonly source: 'native' | 'custom'
}

/**
 * The modes of the endpoint: native presets first, then custom ones, one per
 * distinct value (names that differ only in case or punctuation collapse, the
 * first wins, and the directive resolves to that first one).
 */
export function presetModesOf(
  native: readonly string[],
  custom: readonly string[],
): readonly PresetMode[] {
  const seen = new Set<string>()
  const out: PresetMode[] = []
  const add = (name: string, source: PresetMode['source']): void => {
    const value = presetValueOf(name)
    if (value === null) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ value, name: name.slice(0, MAX_NAME), source })
  }
  for (const name of native) add(name, 'native')
  for (const name of custom) add(name, 'custom')
  return out
}

function textNames(name: string): readonly AlexaFriendlyName[] {
  return [
    { '@type': 'text', value: { text: name, locale: 'it-IT' } },
    { '@type': 'text', value: { text: name, locale: 'en-US' } },
  ]
}

const SPEED_NAMES: readonly AlexaFriendlyName[] = [
  { '@type': 'asset', value: { assetId: 'Alexa.Setting.FanSpeed' } },
  { '@type': 'text', value: { text: 'Velocità', locale: 'it-IT' } },
  { '@type': 'text', value: { text: 'Speed', locale: 'en-US' } },
]

function speedCapability(step: number | undefined): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.RangeController',
    version: '3',
    instance: INSTANCE_SPEED,
    capabilityResources: { friendlyNames: SPEED_NAMES },
    properties: {
      supported: [{ name: 'rangeValue' }],
      proactivelyReported: true,
      retrievable: true,
    },
    configuration: {
      supportedRange: {
        minimumValue: 0,
        maximumValue: 100,
        precision: step ?? 1,
      },
      unitOfMeasure: 'Alexa.Unit.Percent',
    },
  }
}

function oscillationCapability(): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ToggleController',
    version: '3',
    instance: INSTANCE_OSCILLATING,
    capabilityResources: {
      friendlyNames: [
        { '@type': 'text', value: { text: 'Oscillazione', locale: 'it-IT' } },
        { '@type': 'text', value: { text: 'Oscillation', locale: 'en-US' } },
      ],
    },
    properties: {
      supported: [{ name: 'toggleState' }],
      proactivelyReported: true,
      retrievable: true,
    },
  }
}

function presetCapability(modes: readonly PresetMode[]): AlexaCapability {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ModeController',
    version: '3',
    instance: INSTANCE_PRESET,
    capabilityResources: {
      friendlyNames: [
        { '@type': 'asset', value: { assetId: 'Alexa.Setting.Preset' } },
        { '@type': 'text', value: { text: 'Modalità', locale: 'it-IT' } },
        { '@type': 'text', value: { text: 'Mode', locale: 'en-US' } },
      ],
    },
    properties: {
      supported: [{ name: 'mode' }],
      proactivelyReported: true,
      retrievable: true,
    },
    configuration: {
      ordered: false,
      supportedModes: modes.map((mode) => ({
        value: mode.value,
        modeResources: { friendlyNames: textNames(mode.name) },
      })),
    },
  }
}

function hasFeature(device: AdapterDevice, feature: DeviceFeature): boolean {
  return device.features.includes(feature)
}

export function describeFan(device: AdapterDevice): AdapterDescription {
  const slice = readFanSlice(device.slices['fan-control'])
  const capabilities: AlexaCapability[] = []
  // The slice says what the fan CAN do; when it could not be read, the
  // declared features do.
  const speed = slice === null ? hasFeature(device, DeviceFeature.FanSpeed) : slice.speed !== null
  if (speed) capabilities.push(speedCapability(slice?.percentageStep))
  const oscillating =
    slice === null ? hasFeature(device, DeviceFeature.FanOscillating) : slice.oscillating !== null
  if (oscillating) capabilities.push(oscillationCapability())
  const modes = presetModesOf(slice?.availablePresets ?? [], customPresetNames(device.slices))
  if (modes.length >= MIN_MODES) capabilities.push(presetCapability(modes))
  return { kind: 'publish', capabilities, category: 'FAN' }
}

export function fanProperties(slice: unknown): readonly GenericProperty[] {
  const fan = readFanSlice(slice)
  if (fan === null) return []
  const out: GenericProperty[] = []
  if (fan.speed !== null) {
    out.push({
      namespace: 'Alexa.RangeController',
      name: 'rangeValue',
      instance: INSTANCE_SPEED,
      value: Math.max(0, Math.min(100, Math.round(fan.speed))),
    })
  }
  if (fan.oscillating !== null) {
    out.push({
      namespace: 'Alexa.ToggleController',
      name: 'toggleState',
      instance: INSTANCE_OSCILLATING,
      value: fan.oscillating ? 'ON' : 'OFF',
    })
  }
  // The mode is reported only when it is a native preset the endpoint lists:
  // a custom preset is a one-shot action and leaves no state behind.
  const current = fan.preset === '' ? null : presetValueOf(fan.preset)
  if (current !== null && fan.availablePresets.some((n) => presetValueOf(n) === current)) {
    out.push({
      namespace: 'Alexa.ModeController',
      name: 'mode',
      instance: INSTANCE_PRESET,
      value: current,
    })
  }
  return out
}
