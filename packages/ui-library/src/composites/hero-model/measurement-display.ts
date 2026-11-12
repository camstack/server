/**
 * A measurement as the operator reads it. The model sends the number in its base
 * unit (`reading`); the row and the card both turn it into text through the ONE
 * display resolution every reading uses (`resolveSensorDisplay`: the user's unit
 * preferences, the device's display override, the role default, precision). A
 * measurement with no number (a contact, a text) is drawn as the model words it.
 */
import type { DeviceDisplayOverride, HeroMeasurement } from '@camstack/types'
import { useUnitPreferences } from '../../contexts/unit-preferences'
import { resolveSensorDisplay } from '../../lib/resolve-sensor-display'
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

export function measurementText(input: MeasurementTextInput): MeasurementText {
  const { measurement, lang, subject } = input
  if (measurement.reading === null) {
    return { value: pickText(measurement.value, lang), unit: measurement.unit }
  }
  const role = subject?.role ?? null
  const resolved = resolveSensorDisplay({
    ...(subject?.display === undefined ? {} : { display: subject.display }),
    ...(role === null || input.roleDefaults[role] === undefined
      ? {}
      : { roleDefault: input.roleDefaults[role] }),
    quantity: measurement.reading.quantity,
    unitPreferences: input.unitPreferences,
  })
  const rendered = resolved.format(measurement.reading.value)
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
