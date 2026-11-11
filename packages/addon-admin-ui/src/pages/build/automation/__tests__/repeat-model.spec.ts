import { AutomationRepeatStepSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  clampCount,
  clampIterations,
  isLoopBy,
  loopFor,
  newRepeat,
  setLoopWait,
} from '../repeat-model'

describe('repeat-model (#500)', () => {
  it('a new repeat is a count of two', () => {
    expect(newRepeat()).toEqual({ kind: 'repeat', loop: { by: 'count', count: 2 }, steps: [] })
  })

  it('switching the form gives a loop the schema takes, with its bound already set', () => {
    for (const by of ['count', 'while', 'until'] as const) {
      const step = { ...newRepeat(), loop: loopFor(by), steps: [{ kind: 'wait', seconds: 1 }] }
      expect(AutomationRepeatStepSchema.safeParse(step).success).toBe(true)
    }
    expect(loopFor('while')).toMatchObject({ maxIterations: 10 })
    expect(loopFor('forEach')).toEqual({ by: 'forEach', target: { kind: 'devices', ids: [] } })
  })

  it('keeps the count and the iterations inside the bounds', () => {
    expect(clampCount(0)).toBe(1)
    expect(clampCount(99)).toBe(20)
    expect(clampCount(Number.NaN)).toBe(1)
    expect(clampIterations(0)).toBe(1)
    expect(clampIterations(500)).toBe(50)
    expect(clampIterations(7.6)).toBe(8)
  })

  it('an empty pause removes the field, a number sets it inside the wait ceiling', () => {
    const loop = loopFor('while')
    expect(setLoopWait(loop, 30)).toMatchObject({ waitS: 30 })
    expect(setLoopWait(loop, 99_999)).toMatchObject({ waitS: 3600 })
    expect(setLoopWait(setLoopWait(loop, 30), null)).not.toHaveProperty('waitS')
    expect(setLoopWait(loopFor('count'), 30)).toEqual(loopFor('count'))
  })

  it('knows its four forms', () => {
    expect(isLoopBy('forEach')).toBe(true)
    expect(isLoopBy('forever')).toBe(false)
  })
})
