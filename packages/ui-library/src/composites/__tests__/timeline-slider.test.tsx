// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { minuteFromPointer, snapMinute, TimelineSlider } from '../timeline-slider'

describe('timeline pointer mapping', () => {
  it('maps the track edges to the first and last minute', () => {
    expect(minuteFromPointer(100, 100, 1440, 5)).toBe(0)
    expect(minuteFromPointer(1540, 100, 1440, 5)).toBe(1439)
  })
  it('snaps to the step and clamps outside the track', () => {
    expect(minuteFromPointer(100 + 723, 100, 1440, 15)).toBe(720)
    expect(minuteFromPointer(-50, 100, 1440, 5)).toBe(0)
    expect(minuteFromPointer(99999, 100, 1440, 5)).toBe(1439)
  })
  it('a zero-width track answers 0 rather than NaN', () => {
    expect(minuteFromPointer(10, 0, 0, 5)).toBe(0)
  })
  it('snapMinute never leaves the day', () => {
    expect(snapMinute(1438, 30)).toBe(1439)
    expect(snapMinute(-4, 30)).toBe(0)
  })
})

describe('TimelineSlider keyboard', () => {
  it('arrow keys move a draggable marker by one step, shift by an hour', () => {
    const onMove = vi.fn()
    render(
      <TimelineSlider
        ariaLabel="day"
        markers={[{ id: 'a', minute: 600, label: '10:00', draggable: true }]}
        onMove={onMove}
      />,
    )
    const marker = screen.getByRole('slider', { name: '10:00' })
    fireEvent.keyDown(marker, { key: 'ArrowRight' })
    fireEvent.keyDown(marker, { key: 'ArrowLeft', shiftKey: true })
    expect(onMove).toHaveBeenNthCalledWith(1, 'a', 605)
    expect(onMove).toHaveBeenNthCalledWith(2, 'a', 540)
  })
  it('a fixed marker does not move', () => {
    const onMove = vi.fn()
    render(
      <TimelineSlider
        ariaLabel="day"
        markers={[{ id: 'a', minute: 600, label: '10:00' }]}
        onMove={onMove}
      />,
    )
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' })
    expect(onMove).not.toHaveBeenCalled()
  })
})
