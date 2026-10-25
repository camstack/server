import { describe, expect, it } from 'vitest'
import { knownOf } from '../customize-facts'

describe('knownOf — D315', () => {
  it('pending, error and success are three answers', () => {
    expect(knownOf({ status: 'pending' }, (d: number) => d)).toEqual({ kind: 'pending' })
    expect(knownOf({ status: 'error', error: { message: 'boom' } }, (d: number) => d)).toEqual({
      kind: 'unknown',
      reason: 'boom',
    })
    expect(knownOf({ status: 'success', data: 2 }, (d: number) => d * 2)).toEqual({
      kind: 'known',
      value: 4,
    })
  })
})
