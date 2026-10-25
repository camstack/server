import { describe, it, expect } from 'vitest'
import { canonicalHash } from '../utils/canonical-hash.js'

describe('canonicalHash', () => {
  it('produces a 64-char lowercase hex digest', () => {
    expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic across calls for the same value', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ a: 1, b: 2 }))
  })

  it('is key-order-insensitive at the top level', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }))
  })

  it('is key-order-insensitive at nested levels', () => {
    expect(canonicalHash({ outer: { x: 1, y: 2 } })).toBe(canonicalHash({ outer: { y: 2, x: 1 } }))
  })

  it('preserves array order (arrays are sequences, not sets)', () => {
    expect(canonicalHash([1, 2, 3])).not.toBe(canonicalHash([3, 2, 1]))
  })

  it('differentiates when a single field changes', () => {
    expect(canonicalHash({ a: 1, b: 2 })).not.toBe(canonicalHash({ a: 1, b: 3 }))
  })

  it('handles null + undefined cleanly', () => {
    expect(canonicalHash(null)).toMatch(/^[0-9a-f]{64}$/)
    // undefined → JSON.stringify returns undefined; the impl coerces to ''
    expect(canonicalHash(undefined)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('handles deeply-nested objects', () => {
    const a = { l1: { l2: { l3: { l4: { value: 'x', meta: { b: 1, a: 2 } } } } } }
    const b = { l1: { l2: { l3: { l4: { meta: { a: 2, b: 1 }, value: 'x' } } } } }
    expect(canonicalHash(a)).toBe(canonicalHash(b))
  })
})
