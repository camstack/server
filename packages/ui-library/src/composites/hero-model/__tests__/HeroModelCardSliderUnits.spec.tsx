/**
 * A bounded control is a slider. Its number is stored in the quantity's base
 * unit; the thumb, the readout and the value sent back follow the operator's
 * display unit, the same resolution a row uses. A release lands on the cap's
 * own step, so a °F thumb does not store a fraction of a °C.
 */
import type { HeroAction, HeroCall } from '@camstack/types'
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
import { MEDIA_FEATURES, MEDIA_SLICE, TEST_LABELS, buildModel } from './fixtures'

type Run = (call: HeroCall, action: HeroAction | null) => void

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null
}

function sentControlValue(call: HeroCall): number {
  const control = call.args.control
  if (!isRecord(control)) throw new Error('expected a control argument')
  const value = control.value
  if (typeof value !== 'number') throw new Error('expected a numeric control value')
  return value
}

function temperatureModel(value: number) {
  return buildModel('control', ['control'], {
    control: {
      kind: 'numeric',
      value,
      min: 0,
      max: 40,
      step: 1,
      options: [],
      lastChangedAt: 1,
    },
  })
}

function withScale(temperature: 'fahrenheit' | 'celsius', node: ReactNode): ReactNode {
  return (
    <UnitPreferencesProvider value={{ system: 'metric', temperature }}>
      <CardDisplaySubjectProvider deviceId={7}>{node}</CardDisplaySubjectProvider>
    </UnitPreferencesProvider>
  )
}

function release(value: string): HTMLElement {
  const slider = screen.getByRole('slider')
  fireEvent.change(slider, { target: { value } })
  fireEvent.pointerUp(slider)
  return slider
}

describe('HeroModelCard slider display units', () => {
  it('a °C slider shown to a °F operator shows °F, and a release snaps onto the °C step', () => {
    const run = vi.fn<Run>()
    render(
      withScale(
        'fahrenheit',
        <HeroModelCard
          model={temperatureModel(20)}
          host={{ lang: 'en', labels: TEST_LABELS, busy: false, run }}
        />,
      ),
    )
    const slider = screen.getByRole('slider')
    expect(Number(slider.getAttribute('value'))).toBeCloseTo(68, 5)
    const readout = slider.parentElement?.querySelector('span')?.textContent ?? ''
    expect(readout).toMatch(/°F/)
    expect(Number.parseFloat(readout)).toBeCloseTo(68, 5)
    release('70')
    const sent = run.mock.calls[0]
    if (sent === undefined) throw new Error('the slider release sent no call')
    expect(sentControlValue(sent[0])).toBe(21)
  })

  it('a °C preference sends the thumb value unchanged', () => {
    const run = vi.fn<Run>()
    render(
      withScale(
        'celsius',
        <HeroModelCard
          model={temperatureModel(20)}
          host={{ lang: 'en', labels: TEST_LABELS, busy: false, run }}
        />,
      ),
    )
    release('22')
    const sent = run.mock.calls[0]
    if (sent === undefined) throw new Error('the slider release sent no call')
    expect(sentControlValue(sent[0])).toBe(22)
  })

  it('a slider with no value is disabled and shows a dash', () => {
    const model = buildModel(
      'media-player',
      ['media-player'],
      { 'media-player': { ...MEDIA_SLICE, volumeLevel: null } },
      true,
      MEDIA_FEATURES,
    )
    render(
      <HeroModelCard
        model={model}
        host={{ lang: 'en', labels: TEST_LABELS, busy: false, run: vi.fn<Run>() }}
      />,
    )
    const slider = screen.getByRole('slider')
    expect(slider.hasAttribute('disabled')).toBe(true)
    expect(slider.parentElement?.querySelector('span')?.textContent).toBe('–')
  })
})
