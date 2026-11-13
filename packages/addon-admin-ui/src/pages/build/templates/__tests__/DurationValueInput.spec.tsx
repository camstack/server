import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { DurationValueInput } from '../DurationValueInput'

describe('DurationValueInput', () => {
  it('shows whole minutes in minutes and hands on seconds', () => {
    const onChange = vi.fn()
    render(<DurationValueInput value={300} aria-label="Delay" onChange={onChange} />)
    const field = screen.getByRole('textbox', { name: 'Delay' })
    expect(field).toHaveProperty('value', '5')
    fireEvent.change(field, { target: { value: '2' } })
    expect(onChange).toHaveBeenLastCalledWith(120)
  })

  it('keeps seconds that are not whole minutes in seconds', () => {
    const onChange = vi.fn()
    render(<DurationValueInput value={45} aria-label="Delay" onChange={onChange} />)
    const field = screen.getByRole('textbox', { name: 'Delay' })
    expect(field).toHaveProperty('value', '45')
    fireEvent.change(field, { target: { value: '30' } })
    expect(onChange).toHaveBeenLastCalledWith(30)
  })
})
