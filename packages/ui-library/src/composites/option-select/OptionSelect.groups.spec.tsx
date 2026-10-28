/**
 * `group` on an option: the list draws one heading where the group changes,
 * and an option with no group draws none.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OptionSelect } from './OptionSelect'

const OPTIONS = [
  { value: 'a', label: 'Alpha', group: 'Lights' },
  { value: 'b', label: 'Beta', group: 'Lights' },
  { value: 'c', label: 'Gamma', group: 'Locks' },
  { value: 'd', label: 'Delta' },
]

describe('OptionSelect groups', () => {
  it('draws a heading per group run, not per option', () => {
    render(
      <OptionSelect
        mode="single"
        options={OPTIONS}
        value=""
        onChange={() => undefined}
        searchable
        optionTestIdPrefix="opt"
      />,
    )
    fireEvent.focus(screen.getByRole('combobox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getAllByText('Lights')).toHaveLength(1)
    expect(screen.getAllByText('Locks')).toHaveLength(1)
    expect(screen.getByTestId('opt-d')).toBeTruthy()
  })
})
