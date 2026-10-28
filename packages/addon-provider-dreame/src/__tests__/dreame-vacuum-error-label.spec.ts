import { MiotError } from '@apocaliss92/nodedreame'
import { describe, expect, it } from 'vitest'
import { vacuumErrorLabel } from '../dreame-vacuum-decode.js'

describe('vacuumErrorLabel', () => {
  it('shows no error for an idle docked robot reporting TaskComplete (68)', () => {
    expect(vacuumErrorLabel(MiotError.TaskComplete)).toBeNull()
  })

  it('shows no error for no code', () => {
    expect(vacuumErrorLabel(null)).toBeNull()
    expect(vacuumErrorLabel(0)).toBeNull()
  })

  it('still labels a real fault', () => {
    expect(MiotError.TaskComplete).not.toBe(1)
    expect(vacuumErrorLabel(1)).toBe('Error 1')
  })
})
