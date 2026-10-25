import { describe, expect, it } from 'vitest'
import { HeatingValveStatusSchema } from '../heating-valve.cap.js'

describe('HeatingValveStatusSchema', () => {
  it('accepts null position and numeric position', () => {
    expect(HeatingValveStatusSchema.parse({ position: null, lastFetchedAt: 1 })).toEqual({
      position: null,
      lastFetchedAt: 1,
    })
    expect(HeatingValveStatusSchema.parse({ position: 50, lastFetchedAt: 2 })).toEqual({
      position: 50,
      lastFetchedAt: 2,
    })
  })

  it('rejects position above 100', () => {
    expect(() => HeatingValveStatusSchema.parse({ position: 101, lastFetchedAt: 0 })).toThrow()
  })
})
