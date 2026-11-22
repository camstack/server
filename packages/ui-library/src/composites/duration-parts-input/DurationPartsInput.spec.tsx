/**
 * DurationPartsInput: one field per unit (hours, minutes, seconds) over a
 * duration stored in seconds. Typing in one field keeps the other two.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DurationPartsInput } from './DurationPartsInput'
import { joinDurationParts, splitDurationParts } from './duration-parts'

describe('duration parts', () => {
  it('splits seconds into hours, minutes and seconds and joins them back', () => {
    expect(splitDurationParts(3_725)).toEqual({ hours: 1, minutes: 2, seconds: 5 })
    expect(joinDurationParts({ hours: 1, minutes: 2, seconds: 5 })).toBe(3_725)
    expect(splitDurationParts(0)).toEqual({ hours: 0, minutes: 0, seconds: 0 })
  })

  it('keeps a fraction of a second in the seconds part', () => {
    expect(splitDurationParts(60.5)).toEqual({ hours: 0, minutes: 1, seconds: 0.5 })
    expect(joinDurationParts({ hours: 0, minutes: 1, seconds: 0.5 })).toBe(60.5)
  })
})

describe('DurationPartsInput', () => {
  const field = (name: string): HTMLInputElement => screen.getByRole('spinbutton', { name })

  it('shows one field per unit', () => {
    render(<DurationPartsInput seconds={3_725} onChange={() => undefined} aria-label="On for" />)
    expect(screen.getByRole('group', { name: 'On for' })).toBeTruthy()
    expect(field('Hours').value).toBe('1')
    expect(field('Minutes').value).toBe('2')
    expect(field('Seconds').value).toBe('5')
  })

  it('typing minutes keeps the hours and the seconds', () => {
    const onChange = vi.fn()
    render(<DurationPartsInput seconds={3_725} onChange={onChange} />)
    fireEvent.change(field('Minutes'), { target: { value: '10' } })
    expect(onChange).toHaveBeenLastCalledWith(3_600 + 600 + 5)
  })

  it('an emptied field counts as zero, and what was typed stays until the field is left', () => {
    const onChange = vi.fn()
    const { rerender } = render(<DurationPartsInput seconds={90} onChange={onChange} />)
    fireEvent.change(field('Minutes'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(30)
    rerender(<DurationPartsInput seconds={30} onChange={onChange} />)
    expect(field('Minutes').value).toBe('')
    fireEvent.blur(field('Minutes'))
    expect(field('Minutes').value).toBe('0')
  })

  it('ninety typed as minutes reads as one hour thirty once the field is left', () => {
    const onChange = vi.fn()
    const { rerender } = render(<DurationPartsInput seconds={0} onChange={onChange} />)
    fireEvent.change(field('Minutes'), { target: { value: '90' } })
    expect(onChange).toHaveBeenLastCalledWith(5_400)
    rerender(<DurationPartsInput seconds={5_400} onChange={onChange} />)
    fireEvent.blur(field('Minutes'))
    expect(field('Hours').value).toBe('1')
    expect(field('Minutes').value).toBe('30')
  })

  it('does not emit a negative number', () => {
    const onChange = vi.fn()
    render(<DurationPartsInput seconds={60} onChange={onChange} />)
    fireEvent.change(field('Seconds'), { target: { value: '-4' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('whole seconds only, unless a fraction is allowed', () => {
    const onChange = vi.fn()
    const { unmount } = render(<DurationPartsInput seconds={0} onChange={onChange} />)
    fireEvent.change(field('Seconds'), { target: { value: '0.5' } })
    expect(onChange).not.toHaveBeenCalled()
    unmount()
    render(<DurationPartsInput seconds={0} onChange={onChange} fractionalSeconds />)
    fireEvent.change(field('Seconds'), { target: { value: '0.5' } })
    expect(onChange).toHaveBeenLastCalledWith(0.5)
  })

  it('marks every field when the duration is outside its bounds', () => {
    render(<DurationPartsInput seconds={0} min={1} max={86_400} onChange={() => undefined} />)
    expect(field('Seconds').getAttribute('aria-invalid')).toBe('true')
  })

  it('takes translated field names', () => {
    render(
      <DurationPartsInput
        seconds={5}
        onChange={() => undefined}
        labels={{ hours: 'Ore', minutes: 'Minuti', seconds: 'Secondi' }}
      />,
    )
    expect(field('Secondi').value).toBe('5')
  })
})
