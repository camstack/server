import {
  contactMeasurement,
  powerMeasurement,
  temperatureMeasurement,
  textMeasurement,
} from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const rowModels = vi.hoisted(() => ({ value: { status: 'pending' } as Record<string, unknown> }))
vi.mock('../../../generated/system-hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../generated/system-hooks')>()),
  useHeroLayoutGetRowModels: () => ({ ...rowModels.value, refetch: () => undefined }),
}))
vi.mock('../use-hero-live-refresh', () => ({ useHeroLiveRefresh: () => undefined }))

import { measurementVisual } from '../MeasurementScene'
import { ModelRowReading } from '../../device-item/model-row-value'

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

describe('a Sensor row reads the row model', () => {
  const fallback = <span>atom</span>

  it('draws nothing while the row model is unanswered', () => {
    rowModels.value = { status: 'pending' }
    const { container } = render(<ModelRowReading deviceId={1} fallback={fallback} />)
    expect(container.textContent).toBe('')
  })

  it('draws the measurement value and its unit', () => {
    rowModels.value = {
      status: 'success',
      data: [{ measurement: temperatureMeasurement(48, null), primary: null }],
    }
    render(<ModelRowReading deviceId={1} fallback={fallback} />)
    expect(screen.getByTestId('row-measurement').textContent).toBe('48°C')
  })

  it('draws the fallback when the model has no row or no measurement', () => {
    rowModels.value = { status: 'success', data: [] }
    render(<ModelRowReading deviceId={1} fallback={fallback} />)
    expect(screen.getByText('atom')).toBeTruthy()
  })
})
