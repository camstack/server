import { AutomationWaitUntilStepSchema, WAIT_UNTIL_TIMEOUT_MAX_S } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { joinTimeout, newWaitUntil, splitTimeout } from '../wait-until-model'

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
