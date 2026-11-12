import {
  contactMeasurement,
  powerMeasurement,
  temperatureMeasurement,
  textMeasurement,
} from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UnitPreferencesProvider } from '../../../contexts/unit-preferences'
import { measurementText } from '../measurement-display'
import { MeasurementScene, measurementVisual } from '../MeasurementScene'

describe('the scene a measurement moves with', () => {
  it('heat when hot, flakes when cold, still when mild', () => {
    expect(measurementVisual(temperatureMeasurement(48, null))?.kind).toBe('heat')
    expect(measurementVisual(temperatureMeasurement(6.9, null))).toMatchObject({
      kind: 'drop',
      speed: 'slow',
    })
    expect(measurementVisual(temperatureMeasurement(21, null))).toBeNull()
  })

  it('the wire runs at the speed of the power and stands still at 0 W', () => {
    expect(measurementVisual(powerMeasurement(100, null))).toMatchObject({
      kind: 'wire',
      speed: 'slow',
    })
    expect(measurementVisual(powerMeasurement(1221, null))?.speed).toBe('normal')
    expect(measurementVisual(powerMeasurement(2900, null))?.speed).toBe('fast')
    expect(measurementVisual(powerMeasurement(0, null))?.dim).toBe(true)
  })

  it('a ring while a contact is open; nothing for a closed contact or a text', () => {
    expect(measurementVisual(contactMeasurement(true, null))?.kind).toBe('ripple')
    expect(measurementVisual(contactMeasurement(false, null))).toBeNull()
    expect(measurementVisual(textMeasurement('Eco', null))).toBeNull()
  })
})

describe('the card draws the reading as the operator displays it', () => {
  it('a Fahrenheit preference shows °F in the scene', () => {
    render(
      <UnitPreferencesProvider value={{ system: 'metric', temperature: 'fahrenheit' }}>
        <MeasurementScene measurement={temperatureMeasurement(48, null)} lang="en" deviceId={1} />
      </UnitPreferencesProvider>,
    )
    expect(
      Number.parseFloat(screen.getByTestId('measurement-value').textContent ?? ''),
    ).toBeCloseTo(118.4, 0)
    expect(screen.getByText('°F')).toBeTruthy()
  })

  it('a device kW override and a role default apply; a contact keeps its words', () => {
    const base = {
      lang: 'en',
      unitPreferences: { system: 'metric', temperature: 'celsius' },
    } as const
    expect(
      measurementText({
        ...base,
        measurement: powerMeasurement(1221, null),
        subject: { role: null, display: { unit: 'kW' } },
        roleDefaults: {},
      }).unit,
    ).toBe('kW')
    expect(
      measurementText({
        ...base,
        measurement: powerMeasurement(1221, null),
        subject: { role: 'power-sensor' },
        roleDefaults: { 'power-sensor': { unit: 'kW' } },
      }).unit,
    ).toBe('kW')
    expect(
      measurementText({
        ...base,
        measurement: contactMeasurement(true, null),
        subject: null,
        roleDefaults: {},
      }),
    ).toEqual({ value: 'Open', unit: null })
  })
})
