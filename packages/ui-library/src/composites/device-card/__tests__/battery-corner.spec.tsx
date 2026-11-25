// @vitest-environment jsdom
/**
 * planning#709: a battery that reports only low/ok plus a voltage (a binary
 * LOW_BAT source) must be drawn as a state beside its volts, not dropped for
 * want of a percentage; a plain percentage keeps its look and gains the volts.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { cardBattery } from '../connected/use-card-common'
import { BatteryCorner } from '../shell/Corner'

afterEach(cleanup)

describe('BatteryCorner', () => {
  it('binary ok: names the state and shows the voltage', () => {
    render(<BatteryCorner level={100} binary voltage={2.9} />)
    const el = screen.getByTestId('dc-battery')
    expect(el.textContent).toContain('Normal')
    expect(el.textContent).toContain('2.9 V')
    expect(el.textContent).not.toContain('%')
    expect(el.className).not.toContain('text-danger')
  })

  it('binary low: low tone, state named, never a percentage', () => {
    render(<BatteryCorner level={15} binary voltage={2.1} />)
    const el = screen.getByTestId('dc-battery')
    expect(el.textContent).toContain('Low')
    expect(el.textContent).not.toContain('15%')
    expect(el.className).toContain('text-danger')
  })

  it('a level with a voltage keeps the percentage and adds the volts', () => {
    render(<BatteryCorner level={64} voltage={3.7} />)
    expect(screen.getByTestId('dc-battery').textContent).toContain('64%')
    expect(screen.getByTestId('dc-battery').textContent).toContain('3.7 V')
  })

  it('a level alone is unchanged', () => {
    render(<BatteryCorner level={64} />)
    expect(screen.getByTestId('dc-battery').textContent).toBe('64%')
  })

  it('a voltage with no level draws the volts only, no state and no low tone', () => {
    render(<BatteryCorner level={null} voltage={3.1} />)
    const el = screen.getByTestId('dc-battery')
    expect(el.textContent).toBe('3.1 V')
    expect(el.className).not.toContain('text-danger')
  })
})

describe('cardBattery', () => {
  it('keeps a voltage-only slice and a binary flag, drops an unknown one', () => {
    expect(cardBattery({ level: null, voltage: 3.1 })).toEqual({ level: null, voltage: 3.1 })
    expect(cardBattery({ level: 100, binary: true, voltage: 2.9 })).toEqual({
      level: 100,
      binary: true,
      voltage: 2.9,
    })
    expect(cardBattery({ level: null })).toBeNull()
    expect(cardBattery(undefined)).toBeNull()
  })
})
