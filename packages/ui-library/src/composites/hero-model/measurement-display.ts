/**
 * A measurement as the operator reads it. The model sends the number in its base
 * unit (`reading`); the row and the card both turn it into text through the ONE
 * display resolution every reading uses (`resolveSensorDisplay`: the user's unit
 * preferences, the device's display override, the role default, precision). A
 * measurement with no number (a contact, a text) is drawn as the model words it;
 * one that has not reported keeps its value empty ("—") but its unit is still the
 * operator's (°F stays °F before the first reading).
 */
import {
  type DeviceDisplayOverride,
  type HeroMeasurement,
  type ReadingQuantity,
  ReadingQuantitySchema,
} from '@camstack/types'
import { useUnitPreferences } from '../../contexts/unit-preferences'
import { type ResolvedSensorDisplay, resolveSensorDisplay } from '../../lib/resolve-sensor-display'
import type { UnitPreferences } from '../../lib/unit-preferences'
import {
  type RoleDisplayDefaults,
  useRoleDisplayDefaults,
} from '../device-item/role-display-defaults-context'
import { type HeroLang, pickText } from './hero-model-view'

/** What of a device the display resolution reads: its role and its display override. */
export interface ReadingDisplaySubject {
  readonly role?: string | null
  readonly display?: DeviceDisplayOverride
}

/** The value and its unit as drawn; `unit` is `null` when there is none. */
export interface MeasurementText {
  readonly value: string
  readonly unit: string | null
}

export interface MeasurementTextInput {
  readonly measurement: HeroMeasurement
  readonly lang: HeroLang
  /** The device, when known; without it only the user's unit preferences apply. */
  readonly subject: ReadingDisplaySubject | null
  readonly unitPreferences: UnitPreferences
  readonly roleDefaults: RoleDisplayDefaults
}

function displayOf(input: MeasurementTextInput, quantity: ReadingQuantity): ResolvedSensorDisplay {
  const { subject } = input
  const role = subject?.role ?? null
  return resolveSensorDisplay({
    ...(subject?.display === undefined ? {} : { display: subject.display }),
    ...(role === null || input.roleDefaults[role] === undefined
      ? {}
      : { roleDefault: input.roleDefaults[role] }),
    quantity,
    unitPreferences: input.unitPreferences,
  })
}

export function measurementText(input: MeasurementTextInput): MeasurementText {
  const { measurement, lang } = input
  if (measurement.reading === null) {
    const value = pickText(measurement.value, lang)
    const quantity = ReadingQuantitySchema.safeParse(measurement.quantity)
    if (measurement.unit === null || !quantity.success) return { value, unit: measurement.unit }
    const unit = displayOf(input, quantity.data).unit
    return { value, unit: unit === '' ? null : unit }
  }
  const rendered = displayOf(input, measurement.reading.quantity).format(measurement.reading.value)
  return { value: rendered.text, unit: rendered.unit === '' ? null : rendered.unit }
}

/** `measurementText` with the user's preferences and the published role defaults. */
export function useMeasurementText(
  measurement: HeroMeasurement,
  lang: HeroLang,
  subject: ReadingDisplaySubject | null,
): MeasurementText {
  const unitPreferences = useUnitPreferences()
  const roleDefaults = useRoleDisplayDefaults()
  return measurementText({ measurement, lang, subject, unitPreferences, roleDefaults })
}
