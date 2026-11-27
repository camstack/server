// @vitest-environment jsdom
/**
 * A fan that also carries a temperature and a humidity binding shows them as a
 * secondary readout row under its controls: read-only, never replacing a control.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fanFixtures } from '../__fixtures__/fan'
import { FanCard } from '../scenes/fan/FanCard'
import type { FanCardActions, FanCardModel, FanReading } from '../scenes/fan/model'

afterEach(cleanup)

const actions: FanCardActions = {
  onPower: vi.fn(),
  onSpeed: vi.fn(),
  onPreset: vi.fn(),
  onDirection: vi.fn(),
  onOscillating: vi.fn(),
  onAxis: vi.fn(),
  onTimerStart: vi.fn(),
  onTimerStop: vi.fn(),
  onTimerSave: vi.fn(),
}

const tower = (): FanCardModel => {
  const f = fanFixtures(0).find((x) => x.id === 'fan-tower')
  if (f === undefined) throw new Error('no fan-tower fixture')
  return f.model
}

const reading = (id: string, name: string, value: string): FanReading => ({ id, name, value })

describe('the fan readout row', () => {
  it('draws the device readings under the controls and keeps every control', () => {
    render(
      <FanCard
        model={{
          ...tower(),
          readings: [
            reading('temperature-0', 'Temperature', '23.5 °C'),
            reading('humidity-1', 'Humidity', '51 %'),
          ],
        }}
        actions={actions}
      />,
    )
    const row = screen.getByTestId('dc-fan-readings')
    const cells = within(row).getAllByTestId('dc-fan-reading')
    expect(cells.map((c) => c.textContent)).toEqual(['Temperature23.5 °C', 'Humidity51 %'])
    expect(screen.getByTestId('dc-fan-power')).toBeTruthy()
    expect(screen.getByTestId('dc-fan-speed')).toBeTruthy()
    expect(screen.getByTestId('dc-fan-preset')).toBeTruthy()
  })

  it('a reading with no data is a dash, never 0', () => {
    render(
      <FanCard
        model={{ ...tower(), readings: [reading('humidity-0', 'Humidity', '—')] }}
        actions={actions}
      />,
    )
    expect(screen.getByTestId('dc-fan-reading').textContent).toBe('Humidity—')
  })

  it('no readings, no row', () => {
    render(<FanCard model={tower()} actions={actions} />)
    expect(screen.queryByTestId('dc-fan-readings')).toBeNull()
  })

  it('more than four readings wrap onto a second row', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => reading(id, id, '1'))
    render(<FanCard model={{ ...tower(), readings: many }} actions={actions} />)
    expect(screen.getAllByTestId('dc-fan-readings')).toHaveLength(2)
    expect(screen.getAllByTestId('dc-fan-reading')).toHaveLength(5)
  })
})
