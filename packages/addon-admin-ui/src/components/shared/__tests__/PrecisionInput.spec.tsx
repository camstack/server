/**
 * PrecisionInput is a 0–10 integer control. Empty clears (inherit); out of
 * range values clamp rather than writing a schema-refused number.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PrecisionInput } from '../PrecisionInput'

describe('PrecisionInput', () => {
  it('clamps values above 10 down to 10', () => {
    const onChange = vi.fn()
    render(<PrecisionInput value="" onChange={onChange} aria-label="Precision" />)
    fireEvent.change(screen.getByLabelText('Precision'), { target: { value: '15' } })
    expect(onChange).toHaveBeenCalledWith('10')
  })

  it('clamps values below 0 up to 0', () => {
    const onChange = vi.fn()
    render(<PrecisionInput value="2" onChange={onChange} aria-label="Precision" />)
    fireEvent.change(screen.getByLabelText('Precision'), { target: { value: '-3' } })
    expect(onChange).toHaveBeenCalledWith('0')
  })

  it('empty clears', () => {
    const onChange = vi.fn()
    render(<PrecisionInput value="2" onChange={onChange} aria-label="Precision" />)
    fireEvent.change(screen.getByLabelText('Precision'), { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('accepts an in-range integer as a string', () => {
    const onChange = vi.fn()
    render(<PrecisionInput value="" onChange={onChange} aria-label="Precision" />)
    fireEvent.change(screen.getByLabelText('Precision'), { target: { value: '3' } })
    expect(onChange).toHaveBeenCalledWith('3')
  })
})
