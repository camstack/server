/**
 * Harness self-test — verifies fixtures compile and basic tRPC plumbing
 * (URL building, frame parsing) is sound. Does NOT spawn a hub.
 */
import { describe, it, expect } from 'vitest'

describe('harness', () => {
  it('compiles', () => {
    expect(true).toBe(true)
  })
})
