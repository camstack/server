/**
 * The signed-in user's unit preferences (account preference, namespace
 * `admin.units`). Stored numbers stay in each quantity's base unit (D944); a
 * preference only picks the label and the conversion at display time.
 *
 * Two independent choices: the temperature scale, and metric or imperial for
 * every other quantity. The default is metric and °C, so a user who never
 * opens the page sees what they always saw.
 */
import {
  DEFAULT_DISPLAY_PREFERENCE,
  DISPLAY_PREFERENCES,
  type DisplayPreference,
  type ReadingQuantity,
} from '@camstack/types'

export const UNIT_PREFERENCES_NAMESPACE = 'admin.units'

export const TEMPERATURE_SCALES = ['celsius', 'fahrenheit'] as const
export type TemperatureScale = (typeof TEMPERATURE_SCALES)[number]

export interface UnitPreferences {
  /** Metric or imperial, for every quantity except temperature. */
  readonly system: DisplayPreference
  readonly temperature: TemperatureScale
}

export const DEFAULT_UNIT_PREFERENCES: UnitPreferences = {
  system: DEFAULT_DISPLAY_PREFERENCE,
  temperature: 'celsius',
}

export interface ParsedUnitPreferences {
  readonly value: UnitPreferences
  /** False when the stored row holds a field this client cannot read. */
  readonly parsed: boolean
}

function isSystem(value: unknown): value is DisplayPreference {
  return DISPLAY_PREFERENCES.some((candidate) => candidate === value)
}

function isScale(value: unknown): value is TemperatureScale {
  return TEMPERATURE_SCALES.some((candidate) => candidate === value)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A missing row or field is the default; a field of the wrong shape is unreadable. */
export function readUnitPreferences(raw: unknown): ParsedUnitPreferences {
  if (raw === undefined || raw === null) return { value: DEFAULT_UNIT_PREFERENCES, parsed: true }
  if (!isRecord(raw)) return { value: DEFAULT_UNIT_PREFERENCES, parsed: false }
  const system = raw['system']
  const temperature = raw['temperature']
  const systemOk = system === undefined || isSystem(system)
  const scaleOk = temperature === undefined || isScale(temperature)
  return {
    value: {
      system: isSystem(system) ? system : DEFAULT_UNIT_PREFERENCES.system,
      temperature: isScale(temperature) ? temperature : DEFAULT_UNIT_PREFERENCES.temperature,
    },
    parsed: systemOk && scaleOk,
  }
}

/** The display preference to hand `formatReading` for one quantity. */
export function preferenceForQuantity(
  preferences: UnitPreferences,
  quantity: ReadingQuantity | undefined,
): DisplayPreference {
  if (quantity === 'temperature') {
    return preferences.temperature === 'fahrenheit' ? 'imperial' : 'metric'
  }
  return preferences.system
}
