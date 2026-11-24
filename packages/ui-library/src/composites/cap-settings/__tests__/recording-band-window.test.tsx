/**
 * The recording band's time window is edited through `TimeWindowInput`, and the
 * stored band keeps its shape: `days` 0-6 (empty = every day), `start` / `end`
 * as `HH:MM`. Only the window fields change; mode, audio and the rest are kept.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RecordingBand } from '@camstack/types'
import { RecordingBandsEditor } from '../RecordingBandsEditor'

const BAND: RecordingBand = {
  days: [1, 2, 3, 4, 5],
  start: '22:00',
  end: '06:00',
  mode: 'events',
  audio: 'muted',
}

describe('RecordingBandsEditor time window', () => {
  it('shows the stored window, offers clock times only, and says it crosses midnight', () => {
    render(<RecordingBandsEditor bands={[BAND]} onChange={() => {}} />)
    expect(screen.getByDisplayValue('22:00')).toBe(screen.getByLabelText('From: Time'))
    expect(screen.getByDisplayValue('06:00')).toBe(screen.getByLabelText('To: Time'))
    expect(screen.queryByText('At a sun event')).toBeNull()
    expect(screen.queryByLabelText('Time of day')).toBeNull()
    expect(screen.getByTestId('recording-band-window-wraps')).toBeTruthy()
  })

  it('an edited end is stored as HH:MM and the rest of the band is untouched', () => {
    const onChange = vi.fn()
    render(<RecordingBandsEditor bands={[BAND]} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('To: Time'), { target: { value: '07:30' } })
    expect(onChange).toHaveBeenCalledWith([{ ...BAND, end: '07:30' }])
  })

  it('a pressed day is released into the stored number list', () => {
    const onChange = vi.fn()
    render(<RecordingBandsEditor bands={[BAND]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Wed' }))
    expect(onChange).toHaveBeenCalledWith([{ ...BAND, days: [1, 2, 4, 5] }])
  })

  it('an empty stored day list reads as every day and is pressed off from the full week', () => {
    const onChange = vi.fn()
    render(<RecordingBandsEditor bands={[{ ...BAND, days: [] }]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sun' }))
    expect(onChange).toHaveBeenCalledWith([{ ...BAND, days: [1, 2, 3, 4, 5, 6] }])
  })
})
