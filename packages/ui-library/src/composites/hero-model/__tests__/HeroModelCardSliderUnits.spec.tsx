/**
 * A bounded control is a slider. Its number is stored in the quantity's base
 * unit; the thumb, the readout and the value sent back follow the operator's
 * display unit, the same resolution a row uses.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../generated/system-hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../generated/system-hooks')>()),
  useDeviceManagerGetDevice: () => ({
    data: {
      role: null,
      sourceInfo: { id: 'ctl', system: 'test', quantity: 'temperature' },
    },
  }),
}))

import { UnitPreferencesProvider } from '../../../contexts/unit-preferences'
import { CardDisplaySubjectProvider } from '../card-display-subject'
import { HeroModelCard } from '../HeroModelCard'
import { buildModel, TEST_LABELS } from './fixtures'

function inFahrenheit(node: ReactNode): ReactNode {
  return (
    <UnitPreferencesProvider value={{ system: 'metric', temperature: 'fahrenheit' }}>
      <CardDisplaySubjectProvider deviceId={7}>{node}</CardDisplaySubjectProvider>
    </UnitPreferencesProvider>
  )
}

describe('HeroModelCard slider display units', () => {
  it('a °C slider shown to a °F operator shows °F, and a release is sent in °C', () => {
    const run = vi.fn()
    const model = buildModel('control', ['control'], {
      control: {
        kind: 'numeric',
        value: 20,
        min: 0,
        max: 40,
        step: 1,
        options: [],
        lastChangedAt: 1,
      },
    })
    render(
      inFahrenheit(
        <HeroModelCard
          model={model}
          host={{ lang: 'en', labels: TEST_LABELS, busy: false, run }}
        />,
      ),
    )
    const slider = screen.getByRole('slider')
    expect(Number(slider.getAttribute('value'))).toBeCloseTo(68, 5)
    const readout = slider.parentElement?.querySelector('span')?.textContent ?? ''
    expect(readout).toMatch(/°F/)
    expect(Number.parseFloat(readout)).toBeCloseTo(68, 5)
    fireEvent.change(slider, { target: { value: '70' } })
    fireEvent.pointerUp(slider)
    const sent = run.mock.calls[0]?.[0] as { args: { control: { value: number } } }
    expect(sent.args.control.value).toBeCloseTo(21.11, 1)
  })
})
