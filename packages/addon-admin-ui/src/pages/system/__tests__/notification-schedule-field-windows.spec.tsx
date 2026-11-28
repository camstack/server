/**
 * The notification schedule's window rows are edited through `TimeWindowInput`;
 * the stored `NcSchedule` keeps its shape (`days` 0-6, `startMinute`,
 * `endMinute`, `timezone`, `invert`).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NcSchedule } from '@dominevo/types'
import { ScheduleField } from '../notification-schedule-field'

const SCHEDULE: NcSchedule = {
  windows: [{ days: [5, 6], startMinute: 1320, endMinute: 360 }],
  timezone: 'Europe/Rome',
  invert: true,
}

describe('ScheduleField windows', () => {
  it('shows an overnight stored window as two clock times and says it crosses midnight', () => {
    render(<ScheduleField value={SCHEDULE} onChange={() => {}} />)
    expect(screen.getByDisplayValue('22:00')).toBe(screen.getByLabelText('From: Time'))
    expect(screen.getByDisplayValue('06:00')).toBe(screen.getByLabelText('To: Time'))
    expect(screen.getByTestId('schedule-window-wraps')).toBeTruthy()
    expect(screen.queryByText('At a sun event')).toBeNull()
  })

  it('an edited time is stored in minutes and the timezone and invert flag survive', () => {
    const onChange = vi.fn()
    render(<ScheduleField value={SCHEDULE} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('To: Time'), { target: { value: '07:30' } })
    expect(onChange).toHaveBeenCalledWith({
      ...SCHEDULE,
      windows: [{ days: [5, 6], startMinute: 1320, endMinute: 450 }],
    })
  })

  it('a pressed day is stored as its number, and the last day cannot be released', () => {
    const onChange = vi.fn()
    render(<ScheduleField value={SCHEDULE} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sat' }))
    expect(onChange).toHaveBeenCalledWith({
      ...SCHEDULE,
      windows: [{ days: [5], startMinute: 1320, endMinute: 360 }],
    })
    onChange.mockClear()
    const lastDay: NcSchedule = {
      ...SCHEDULE,
      windows: [{ days: [5], startMinute: 1320, endMinute: 360 }],
    }
    render(<ScheduleField value={lastDay} onChange={onChange} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Fri' })[1] as HTMLElement)
    expect(onChange).not.toHaveBeenCalled()
  })
})
