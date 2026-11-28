import {
  AutomationWaitUntilStepSchema,
  WAIT_MAX_SECONDS,
  WAIT_UNTIL_TIMEOUT_MAX_S,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { clampTimeout, clampWait, newWaitUntil } from '../wait-until-model'

describe('wait-until-model (#500)', () => {
  it('writes whole seconds, never under one and never over six hours', () => {
    expect(clampTimeout(600)).toBe(600)
    expect(clampTimeout(5399.6)).toBe(5400)
    expect(clampTimeout(0)).toBe(1)
    expect(clampTimeout(Number.NaN)).toBe(1)
    expect(clampTimeout(7 * 3600)).toBe(WAIT_UNTIL_TIMEOUT_MAX_S)
  })

  it('a new step is one the schema accepts as soon as it has a condition', () => {
    const step = newWaitUntil()
    expect(step).toMatchObject({ kind: 'wait-until', timeoutS: 600, onTimeout: 'continue' })
    expect(AutomationWaitUntilStepSchema.safeParse(step).success).toBe(true)
  })
})

describe('wait step duration', () => {
  it('keeps a fraction of a second, to the millisecond', () => {
    expect(clampWait(90)).toBe(90)
    expect(clampWait(0.5)).toBe(0.5)
    expect(clampWait(0.12345)).toBe(0.123)
  })

  it('stays inside what the schema takes: never negative, never past the longest wait', () => {
    expect(clampWait(-3)).toBe(0)
    expect(clampWait(Number.NaN)).toBe(0)
    expect(clampWait(2 * 3600)).toBe(WAIT_MAX_SECONDS)
  })
})
