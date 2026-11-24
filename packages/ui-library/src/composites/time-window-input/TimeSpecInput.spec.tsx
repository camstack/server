/**
 * TimeSpecInput: a clock time, a sun event with an offset, or a date, each a
 * `TimeSpec` that passes `TimeSpecSchema`.
 */
import { type TimeSpec, TimeSpecSchema } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TimeSpecInput } from './TimeSpecInput'

function last(onChange: ReturnType<typeof vi.fn>): TimeSpec {
  return TimeSpecSchema.parse(onChange.mock.calls.at(-1)?.[0])
}

describe('TimeSpecInput', () => {
  it('shows a clock time and writes the edited one back as hh/mm', () => {
    const onChange = vi.fn()
    render(<TimeSpecInput label="At" value={{ kind: 'clock', hh: 7, mm: 5 }} onChange={onChange} />)
    const time = screen.getByLabelText('At: Time')
    expect(time).toHaveProperty('value', '07:05')
    fireEvent.change(time, { target: { value: '21:45' } })
    expect(last(onChange)).toEqual({ kind: 'clock', hh: 21, mm: 45 })
  })

  it('a sun event keeps its event and offset; the offset takes negative numbers', () => {
    const onChange = vi.fn()
    render(
      <TimeSpecInput
        label="At"
        value={{ kind: 'sun', event: 'sunset', offsetMin: -30 }}
        onChange={onChange}
      />,
    )
    const offset = screen.getByLabelText(/^At: Offset/)
    expect(offset).toHaveProperty('value', '-30')
    fireEvent.change(offset, { target: { value: '-45' } })
    expect(last(onChange)).toEqual({
      kind: 'sun',
      event: 'sunset',
      offsetMin: -45,
    })
  })

  it('a decimal offset is not rounded while typing; the integer commits on blur, and -0 is 0', () => {
    const onChange = vi.fn()
    render(
      <TimeSpecInput
        label="At"
        value={{ kind: 'sun', event: 'sunset', offsetMin: 0 }}
        onChange={onChange}
      />,
    )
    const offset = screen.getByLabelText(/^At: Offset/)
    fireEvent.change(offset, { target: { value: '1' } })
    expect(last(onChange)).toEqual({
      kind: 'sun',
      event: 'sunset',
      offsetMin: 1,
    })
    onChange.mockClear()
    fireEvent.change(offset, { target: { value: '1.' } })
    fireEvent.change(offset, { target: { value: '1.5' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(offset).toHaveProperty('value', '1.5')
    fireEvent.blur(offset)
    expect(last(onChange)).toEqual({
      kind: 'sun',
      event: 'sunset',
      offsetMin: 2,
    })
    onChange.mockClear()
    fireEvent.change(offset, { target: { value: '-0' } })
    const written = last(onChange)
    expect(written?.kind === 'sun' && Object.is(written.offsetMin, 0)).toBe(true)
  })

  it('switching kind seeds a blank spec of the new kind', () => {
    const onChange = vi.fn()
    render(<TimeSpecInput label="At" value={{ kind: 'clock', hh: 7, mm: 5 }} onChange={onChange} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'At' }))
    fireEvent.click(screen.getByRole('option', { name: 'At a sun event' }))
    expect(last(onChange)).toEqual({
      kind: 'sun',
      event: 'sunset',
      offsetMin: 0,
    })
  })

  it('offers a date only when the caller allows it', () => {
    const { rerender } = render(
      <TimeSpecInput label="At" value={{ kind: 'clock', hh: 7, mm: 5 }} onChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'At' }))
    expect(screen.queryByRole('option', { name: 'On a date' })).toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    rerender(
      <TimeSpecInput
        label="At"
        allowDate
        value={{ kind: 'date', local: '2026-12-24T18:00' }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('At: Date and time')).toHaveProperty('value', '2026-12-24T18:00')
  })

  it('disables the sun choice with its reason when the site has no location', () => {
    render(
      <TimeSpecInput
        label="At"
        siteHasNoLocation
        value={{ kind: 'sun', event: 'sunrise', offsetMin: 0 }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByText(/no location/)).toBeTruthy()
    fireEvent.click(screen.getByRole('combobox', { name: 'At' }))
    expect(
      screen.getByRole('option', { name: 'At a sun event' }).getAttribute('aria-disabled'),
    ).toBe('true')
  })
})
