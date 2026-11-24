// @vitest-environment jsdom
/**
 * A duration shown in hours / minutes but STORED in minutes (#661): typing in the display units
 * must write the same stored number the old minutes-only box wrote, so no saved recipe changes.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RunModeSelector } from '../RunModeSelector'
import { IntervalFields } from '../SceneFields'

describe('interval trigger — stored in minutes', () => {
  it('shows 480 stored minutes as 8 h and writes minutes back', () => {
    const onChange = vi.fn()
    render(<IntervalFields leaf={{ kind: 'interval', minutes: 480 }} onChange={onChange} />)
    expect((screen.getByTestId('interval-hours') as HTMLInputElement).value).toBe('8')
    expect((screen.getByTestId('interval-minutes') as HTMLInputElement).value).toBe('0')
    fireEvent.change(screen.getByTestId('interval-hours'), { target: { value: '2' } })
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'interval', minutes: 120 })
    fireEvent.change(screen.getByTestId('interval-minutes'), { target: { value: '15' } })
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'interval', minutes: 495 })
  })
})

describe('run mode cooldown — stored in minutes', () => {
  it('writes whole minutes whatever units were typed', () => {
    const onChange = vi.fn()
    render(<RunModeSelector value={{ mode: 'cooldown', minutes: 90 }} onChange={onChange} />)
    expect((screen.getByTestId('run-mode-cooldown-hours') as HTMLInputElement).value).toBe('1')
    expect((screen.getByTestId('run-mode-cooldown-minutes') as HTMLInputElement).value).toBe('30')
    fireEvent.change(screen.getByTestId('run-mode-cooldown-hours'), { target: { value: '3' } })
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'cooldown', minutes: 210 })
  })
})
