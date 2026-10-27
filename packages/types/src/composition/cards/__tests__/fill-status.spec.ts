import { describe, expect, it } from 'vitest'
import {
  compositionFillStatus,
  isUnfilledRequiredProblem,
  problemsBlockSave,
} from '../fill-status.js'

describe('compositionFillStatus', () => {
  const unfilled = {
    code: 'missing-field' as const,
    path: 'features[0].fields.temperature',
    message: '`temperature-sensor.temperature` is required and has no source',
  }
  const cycle = {
    code: 'cycle' as const,
    path: 'features[0].fields.temperature',
    message: 'cycle',
  }

  it('omitted required value field → incomplete', () => {
    expect(compositionFillStatus([unfilled])).toBe('incomplete')
    expect(isUnfilledRequiredProblem(unfilled)).toBe(true)
    expect(problemsBlockSave([unfilled])).toBe(false)
  })

  it('all present → complete', () => {
    expect(compositionFillStatus([])).toBe('complete')
    expect(problemsBlockSave([])).toBe(false)
  })

  it('a real validation problem still blocks save', () => {
    expect(compositionFillStatus([unfilled, cycle])).toBe('incomplete')
    expect(problemsBlockSave([unfilled, cycle])).toBe(true)
  })
})
