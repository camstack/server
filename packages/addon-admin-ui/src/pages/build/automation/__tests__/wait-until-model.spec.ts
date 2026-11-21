import { AutomationWaitUntilStepSchema, WAIT_UNTIL_TIMEOUT_MAX_S } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { WAIT_MAX_SECONDS } from '@camstack/types'
import { joinTimeout, joinWait, newWaitUntil, splitTimeout, splitWait } from '../wait-until-model'

describe('wait-until-model (#500)', () => {
  it('shows a timeout in the largest unit that holds it exactly', () => {
    expect(splitTimeout(45)).toEqual({ value: 45, unit: 's' })
    expect(splitTimeout(600)).toEqual({ value: 10, unit: 'min' })
    expect(splitTimeout(7200)).toEqual({ value: 2, unit: 'h' })
    expect(splitTimeout(5400)).toEqual({ value: 90, unit: 'min' })
    expect(splitTimeout(3601)).toEqual({ value: 3601, unit: 's' })
  })

  it('writes whole seconds, never under one and never over six hours', () => {
    expect(joinTimeout(10, 'min')).toBe(600)
    expect(joinTimeout(1.5, 'h')).toBe(5400)
    expect(joinTimeout(0, 's')).toBe(1)
    expect(joinTimeout(Number.NaN, 'min')).toBe(1)
    expect(joinTimeout(7, 'h')).toBe(WAIT_UNTIL_TIMEOUT_MAX_S)
  })

  it('a new step is one the schema accepts as soon as it has a condition', () => {
    const step = newWaitUntil()
    expect(step).toMatchObject({ kind: 'wait-until', timeoutS: 600, onTimeout: 'continue' })
    expect(AutomationWaitUntilStepSchema.safeParse(step).success).toBe(true)
  })
})

describe('wait step duration (one number and a unit, same rule as the timeout)', () => {
  it('90000 ms is stored as 90 s and shown as 90 seconds, the largest unit that holds it exactly', () => {
    expect(joinWait(90_000, 'ms')).toBe(90)
    expect(splitWait(90)).toEqual({ value: 90, unit: 's' })
    expect(joinWait(90, 's')).toBe(90)
    expect(joinWait(1.5, 'min')).toBe(90)
  })

  it('round-trips every unit', () => {
    for (const seconds of [0, 0.25, 0.5, 1, 45, 60, 90, 1800, 3600]) {
      const view = splitWait(seconds)
      expect(joinWait(view.value, view.unit)).toBe(seconds)
    }
    expect(splitWait(0.5)).toEqual({ value: 500, unit: 'ms' })
    expect(splitWait(600)).toEqual({ value: 10, unit: 'min' })
    expect(splitWait(3600)).toEqual({ value: 1, unit: 'h' })
  })

  it('stays inside what the schema takes: never negative, never past the longest wait', () => {
    expect(joinWait(-3, 's')).toBe(0)
    expect(joinWait(Number.NaN, 'min')).toBe(0)
    expect(joinWait(2, 'h')).toBe(WAIT_MAX_SECONDS)
  })
})
