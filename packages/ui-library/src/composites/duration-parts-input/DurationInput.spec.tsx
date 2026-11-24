/**
 * DurationInput: one field per visible unit over a duration stored in `ms`
 * or `s`.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DurationInput } from './DurationInput'
import { joinDuration, splitDuration } from './duration-parts'

describe('split and join', () => {
  it.each([
    [3_725_000, 'ms', ['hours', 'minutes', 'seconds'], { hours: 1, minutes: 2, seconds: 5 }],
    [3_725, 's', ['hours', 'minutes', 'seconds'], { hours: 1, minutes: 2, seconds: 5 }],
    [1_500, 'ms', ['seconds', 'millis'], { seconds: 1, millis: 500 }],
    [90, 's', ['minutes'], { minutes: 1.5 }],
    [250, 'ms', ['seconds'], { seconds: 0.25 }],
  ] as const)('%s %s over %j', (value, storage, units, expected) => {
    expect(splitDuration(value, storage, units)).toEqual(expected)
    expect(joinDuration(expected, storage)).toBe(value)
  })
})

describe('DurationInput', () => {
  const field = (name: string): HTMLInputElement => screen.getByRole('spinbutton', { name })

  it('shows only the units the caller names', () => {
    render(
      <DurationInput
        value={1_500}
        storageUnit="ms"
        units={['seconds', 'millis']}
        onChange={() => undefined}
        aria-label="Delay"
      />,
    )
    expect(screen.getByRole('group', { name: 'Delay' })).toBeTruthy()
    expect(field('Seconds').value).toBe('1')
    expect(field('Milliseconds').value).toBe('500')
    expect(screen.queryByRole('spinbutton', { name: 'Hours' })).toBeNull()
  })

  it('emits in the storage unit, not in seconds', () => {
    const onChange = vi.fn()
    render(
      <DurationInput
        value={1_500}
        storageUnit="ms"
        units={['seconds', 'millis']}
        onChange={onChange}
      />,
    )
    fireEvent.change(field('Seconds'), { target: { value: '3' } })
    expect(onChange).toHaveBeenLastCalledWith(3_500)
  })

  it('emits seconds when stored in seconds', () => {
    const onChange = vi.fn()
    render(<DurationInput value={5} storageUnit="s" onChange={onChange} />)
    fireEvent.change(field('Minutes'), { target: { value: '2' } })
    expect(onChange).toHaveBeenLastCalledWith(125)
  })

  it('marks the fields outside the bounds, in the storage unit', () => {
    const { rerender } = render(
      <DurationInput
        value={500}
        storageUnit="ms"
        min={1_000}
        units={['seconds']}
        onChange={() => undefined}
      />,
    )
    expect(field('Seconds').getAttribute('aria-invalid')).toBe('true')
    rerender(
      <DurationInput
        value={1_500}
        storageUnit="ms"
        min={1_000}
        max={2_000}
        units={['seconds']}
        onChange={() => undefined}
      />,
    )
    expect(field('Seconds').getAttribute('aria-invalid')).toBe('false')
  })

  it('does not emit a negative or, without a fraction, a decimal number', () => {
    const onChange = vi.fn()
    render(
      <DurationInput
        value={0}
        storageUnit="ms"
        units={['seconds', 'millis']}
        onChange={onChange}
      />,
    )
    fireEvent.change(field('Milliseconds'), { target: { value: '-4' } })
    fireEvent.change(field('Milliseconds'), { target: { value: '1.5' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})
