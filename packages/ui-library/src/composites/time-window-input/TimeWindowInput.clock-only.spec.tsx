/**
 * `clockOnly`: the input offers what a stored clock range can hold (two clock
 * times and the weekdays) and nothing else.
 */
import type { TimeWindow } from '@dominevo/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TimeWindowInput } from './TimeWindowInput'

const WINDOW: TimeWindow = {
  days: ['mon'],
  between: { from: { kind: 'clock', hh: 9, mm: 0 }, to: { kind: 'clock', hh: 17, mm: 0 } },
}

describe('TimeWindowInput clockOnly', () => {
  it('renders no mode select, no sun kind select and no presets, only the two times and the days', () => {
    render(<TimeWindowInput clockOnly value={WINDOW} onChange={() => {}} />)
    expect(screen.queryByLabelText('Time of day')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByLabelText('From: Time')).toBeTruthy()
    expect(screen.getByLabelText('To: Time')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mon' })).toBeTruthy()
  })

  it('still emits clock ends', () => {
    const onChange = vi.fn()
    render(<TimeWindowInput clockOnly value={WINDOW} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('From: Time'), { target: { value: '08:15' } })
    expect(onChange).toHaveBeenCalledWith({
      ...WINDOW,
      between: { ...WINDOW.between, from: { kind: 'clock', hh: 8, mm: 15 } },
    })
  })
})
