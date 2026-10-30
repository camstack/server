/**
 * An action arg that is a quantity (D972): the vocabulary offer's bounds are
 * converted into the picked unit, and a typed number is emitted as the stored
 * number plus the picked unit.
 */
import type { LooseVocabOpenArg } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ArgField } from '../ArgField'

const ARG: LooseVocabOpenArg = {
  key: 'grams',
  label: { en: 'Portion', it: 'Porzione' },
  offer: { kind: 'number', unit: 'g', quantity: 'mass', min: 4, max: 200 },
}

describe('ArgField on a quantity arg', () => {
  it('shows the bounds in the unit the person picked', () => {
    render(
      <ArgField
        arg={ARG}
        locale="en"
        variables={[]}
        value={{ kind: 'fixed', value: 56.699, unit: 'oz' }}
        onChange={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('Portion') as HTMLInputElement).value).toBe('2')
    expect(screen.getByText(/0\.1411 to 7\.055 oz/)).toBeTruthy()
  })

  it('emits the stored number and the picked unit', () => {
    const onChange = vi.fn()
    render(
      <ArgField
        arg={ARG}
        locale="en"
        variables={[]}
        value={{ kind: 'fixed', value: 56.699, unit: 'oz' }}
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByLabelText('Portion'), { target: { value: '3' } })
    expect(onChange).toHaveBeenCalledWith({ kind: 'fixed', value: 85.0485, unit: 'oz' })
  })

  it('flags a number outside the bounds, whatever the unit it is shown in', () => {
    render(
      <ArgField
        arg={ARG}
        locale="en"
        variables={[]}
        value={{ kind: 'fixed', value: 300, unit: 'oz' }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
