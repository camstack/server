// @vitest-environment jsdom
/**
 * The suggestion list belongs to typing: an input that merely shows its value
 * (a dialog opening on `x`) must not open a list that repeats it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ExpressionInput } from '../ExpressionInput'

function mount() {
  return render(
    <ExpressionInput label="Formula" value="x" bindings={['x']} onChange={() => undefined} />,
  )
}

describe('ExpressionInput suggestions', () => {
  it('shows none until the input is focused', () => {
    mount()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows them while the input is focused and hides them on blur', () => {
    mount()
    const input = screen.getByLabelText('Formula')
    fireEvent.focus(input)
    expect(screen.queryByRole('listbox')).not.toBeNull()
    fireEvent.blur(input)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
