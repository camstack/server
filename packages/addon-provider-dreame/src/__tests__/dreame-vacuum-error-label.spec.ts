import { MiotError } from '@apocaliss92/nodedreame'
import { describe, expect, it } from 'vitest'
import { vacuumErrorLabel, vacuumErrorReading } from '../dreame-vacuum-decode.js'

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

describe('vacuumErrorReading (the `error` cap)', () => {
  it('does not activate for a benign completion code or for no error', () => {
    expect(vacuumErrorReading(MiotError.TaskComplete, 10)).toMatchObject({
      active: false,
      code: null,
    })
    expect(vacuumErrorReading(0, 10)).toMatchObject({ active: false, label: null })
  })

  it('is UNKNOWN, not clear, when the robot reported nothing', () => {
    expect(vacuumErrorReading(null, 10).active).toBeNull()
  })

  it('activates on a real fault, with the code and a readable label', () => {
    expect(vacuumErrorReading(MiotError.DirtyWaterTankFull, 10)).toMatchObject({
      active: true,
      code: String(MiotError.DirtyWaterTankFull),
      label: 'Dirty Water Tank Full',
      severity: 'error',
      lastFetchedAt: 10,
    })
  })
})
