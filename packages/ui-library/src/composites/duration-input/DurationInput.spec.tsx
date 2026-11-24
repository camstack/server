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
  it('stores minutes: the stored value survives a round trip unchanged', () => {
    const onChange = vi.fn()
    render(
      <DurationInput
        value={90}
        storageUnit="min"
        units={['hours', 'minutes']}
        onChange={onChange}
      />,
    )
    expect(field('Hours').value).toBe('1')
    expect(field('Minutes').value).toBe('30')
    fireEvent.change(field('Minutes'), { target: { value: '45' } })
    expect(onChange).toHaveBeenLastCalledWith(105)
    fireEvent.change(field('Minutes'), { target: { value: '30' } })
    expect(onChange).toHaveBeenLastCalledWith(90)
  })

  it('optional: shows empty fields for undefined and emits undefined when cleared', () => {
    const onChange = vi.fn()
    const { rerender } = render(<DurationInput optional value={undefined} onChange={onChange} />)
    expect(field('Seconds').value).toBe('')
    rerender(<DurationInput optional value={30} onChange={onChange} />)
    fireEvent.change(field('Seconds'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it('deferred: emits once when focus leaves the group, nothing for an emptied group', () => {
    const onChange = vi.fn()
    render(
      <div>
        <DurationInput deferred value={60} units={['minutes', 'seconds']} onChange={onChange} />
        <button type="button">elsewhere</button>
      </div>,
    )
    fireEvent.change(field('Minutes'), { target: { value: '2' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(field('Minutes'), { relatedTarget: screen.getByText('elsewhere') })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(120)

    fireEvent.change(field('Minutes'), { target: { value: '' } })
    fireEvent.change(field('Seconds'), { target: { value: '' } })
    fireEvent.blur(field('Seconds'), { relatedTarget: screen.getByText('elsewhere') })
    expect(onChange).toHaveBeenCalledTimes(1)
  })
  it('required: emptying every box emits nothing and redisplays the kept value on blur', () => {
    const onChange = vi.fn()
    render(<DurationInput value={5} units={['minutes', 'seconds']} onChange={onChange} />)
    fireEvent.change(field('Seconds'), { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(field('Seconds'))
    expect(field('Seconds').value).toBe('5')
  })

  it('deferred: an emptied group tells the caller through onEmptyCommit', () => {
    const onChange = vi.fn()
    const onEmptyCommit = vi.fn()
    render(
      <DurationInput
        deferred
        value={5}
        units={['seconds']}
        onChange={onChange}
        onEmptyCommit={onEmptyCommit}
      />,
    )
    fireEvent.change(field('Seconds'), { target: { value: '' } })
    fireEvent.blur(field('Seconds'))
    expect(onChange).not.toHaveBeenCalled()
    expect(onEmptyCommit).toHaveBeenCalledTimes(1)
  })
})
