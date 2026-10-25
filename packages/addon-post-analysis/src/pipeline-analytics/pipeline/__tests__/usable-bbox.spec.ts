import { describe, expect, it } from 'vitest'
import { isUsableBbox } from '../usable-bbox.js'

describe('isUsableBbox', () => {
  it('rejects the zero box emitted on track close', () => {
    expect(isUsableBbox({ w: 0, h: 0 })).toBe(false)
    expect(isUsableBbox({ w: 0, h: 20 })).toBe(false)
  })

  it('accepts a real detection box', () => {
    expect(isUsableBbox({ w: 15.5, h: 32.3 })).toBe(true)
  })
})
