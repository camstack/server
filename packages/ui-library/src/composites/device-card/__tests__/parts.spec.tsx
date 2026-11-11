// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARMED_WINDOW_MS, ArmedButton } from '../parts/ArmedButton'
import { CardButton } from '../parts/CardButton'
import { dialFractionAt, dialSnap } from '../parts/Dial'
import { stepPlugTimer, splitPlugDuration, PLUG_TIMER_MIN_MINUTES } from '../scenes/plug/model'
import { deriveClimateActivity, nextChoice } from '../scenes/climate/model'
import { CardGatingProvider } from '../shell/gating'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ArmedButton — the one two-step confirmation', () => {
  it('arms on the first press and runs only on the second', () => {
    const onConfirm = vi.fn()
    render(
      <ArmedButton onConfirm={onConfirm} testId="go">
        Restart
      </ArmedButton>,
    )
    fireEvent.click(screen.getByTestId('go'))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByTestId('go').textContent).toContain('Confirm')
    expect(screen.getByTestId('dc-armed-cancel')).toBeTruthy()
    fireEvent.click(screen.getByTestId('go'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('dc-armed-cancel')).toBeNull()
  })

  it('disarms when Cancel is pressed', () => {
    const onConfirm = vi.fn()
    render(
      <ArmedButton onConfirm={onConfirm} testId="go">
        Restart
      </ArmedButton>,
    )
    fireEvent.click(screen.getByTestId('go'))
    fireEvent.click(screen.getByTestId('dc-armed-cancel'))
    expect(screen.getByTestId('go').textContent).toContain('Restart')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('stays armed for five seconds, then disarms on its own', () => {
    vi.useFakeTimers()
    expect(ARMED_WINDOW_MS).toBe(5_000)
    const onConfirm = vi.fn()
    render(
      <ArmedButton onConfirm={onConfirm} testId="go">
        Restart
      </ArmedButton>,
    )
    fireEvent.click(screen.getByTestId('go'))
    act(() => {
      vi.advanceTimersByTime(ARMED_WINDOW_MS - 1)
    })
    expect(screen.queryByTestId('dc-armed-cancel')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByTestId('dc-armed-cancel')).toBeNull()
    // The next press arms again: it never runs an action whose window closed.
    fireEvent.click(screen.getByTestId('go'))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('gating — a blocked card commands nothing', () => {
  it('disables a button and says why', () => {
    const onClick = vi.fn()
    render(
      <CardGatingProvider value={{ blocked: true, reason: 'Offline for 2 h' }}>
        <CardButton onClick={onClick} data-testid="b">
          On
        </CardButton>
      </CardGatingProvider>,
    )
    const button = screen.getByTestId('b')
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toBe('Offline for 2 h')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('leaves a button that does not actuate usable', () => {
    render(
      <CardGatingProvider value={{ blocked: true, reason: 'Read only' }}>
        <CardButton actuates={false} data-testid="b">
          Back
        </CardButton>
      </CardGatingProvider>,
    )
    expect(screen.getByTestId('b')).toHaveProperty('disabled', false)
  })
})

describe('Dial maths', () => {
  it('maps the 270 degree arc to 0..1 and clamps the dead zone to the nearer end', () => {
    expect(dialFractionAt(0, -1)).toBeCloseTo(0.5, 5)
    expect(dialFractionAt(-1, 1)).toBeCloseTo(0, 5)
    expect(dialFractionAt(1, 1)).toBeCloseTo(1, 5)
    expect(dialFractionAt(-0.2, 1)).toBe(0)
    expect(dialFractionAt(0.2, 1)).toBe(1)
  })

  it('snaps to the step inside the bounds', () => {
    expect(dialSnap(0, 16, 30, 0.5)).toBe(16)
    expect(dialSnap(1, 16, 30, 0.5)).toBe(30)
    expect(dialSnap(0.44, 16, 30, 0.5)).toBe(22)
    expect(dialSnap(2, 16, 30, 0.5)).toBe(30)
  })
})

describe('plug timer steps', () => {
  it('steps 5 minutes up to an hour, then 15', () => {
    expect(stepPlugTimer(25, 1, 240)).toBe(30)
    expect(stepPlugTimer(60, 1, 240)).toBe(75)
    expect(stepPlugTimer(75, -1, 240)).toBe(60)
    expect(stepPlugTimer(60, -1, 240)).toBe(55)
  })

  it('never leaves the declared range', () => {
    expect(stepPlugTimer(PLUG_TIMER_MIN_MINUTES, -1, 240)).toBe(PLUG_TIMER_MIN_MINUTES)
    expect(stepPlugTimer(235, 1, 240)).toBe(240)
    expect(splitPlugDuration(95)).toEqual({ hours: 1, minutes: 35 })
  })
})

describe('climate model', () => {
  it('cycles a choice and wraps', () => {
    const options = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]
    expect(nextChoice({ value: 'a', options })).toBe('b')
    expect(nextChoice({ value: 'b', options })).toBe('a')
    expect(nextChoice({ value: null, options: [] })).toBeNull()
  })

  it('derives what the unit is doing from the gap to the target', () => {
    expect(deriveClimateActivity({ on: false, cooling: true, target: 22, current: 25 })).toBe('off')
    expect(deriveClimateActivity({ on: true, cooling: true, target: 22, current: 25 })).toBe('cool')
    expect(deriveClimateActivity({ on: true, cooling: false, target: 22, current: 19 })).toBe(
      'heat',
    )
    expect(deriveClimateActivity({ on: true, cooling: false, target: 22, current: 22 })).toBe(
      'idle',
    )
  })
})
