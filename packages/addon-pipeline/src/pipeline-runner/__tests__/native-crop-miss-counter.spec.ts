import { describe, expect, it } from 'vitest'
import { NativeCropMissCounter } from '../native-crop-miss-counter.js'

describe('NativeCropMissCounter', () => {
  it('counts per camera and forgets on detach', () => {
    const c = new NativeCropMissCounter()
    c.note(1)
    c.note(1)
    c.note(2)
    expect(c.total(1)).toBe(2)
    expect(c.total(2)).toBe(1)
    expect(c.total(3)).toBe(0)
    c.forget(1)
    expect(c.total(1)).toBe(0)
    expect(c.total(2)).toBe(1)
  })
})
