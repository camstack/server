/**
 * Unit tests for the shared `isAbsentProvider` helper.
 *
 * Covers:
 *  - Typed-path: `data.capRouteReason` field present (from the errorFormatter)
 *  - Substring fallback: no `capRouteReason`, message includes legacy text
 *  - Boundary: transport-failed must return false (real error, not absence)
 */
import { describe, it, expect } from 'vitest'
import { isAbsentProvider } from '../cap-error'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulate a tRPC client error with a typed capRouteReason attached.
 * Real tRPC client errors carry `data` on the error object.
 */
function makeTypedError(reason: string, message = 'route failed'): unknown {
  const err = new Error(message)
  Object.assign(err, { data: { capRouteReason: reason } })
  return err
}

function makeLegacyError(message: string): unknown {
  return new Error(message)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('isAbsentProvider', () => {
  // ── Typed path ────────────────────────────────────────────────────────────

  it('returns true for capRouteReason === "no-provider"', () => {
    expect(isAbsentProvider(makeTypedError('no-provider'))).toBe(true)
  })

  it('returns true for capRouteReason === "node-offline"', () => {
    expect(isAbsentProvider(makeTypedError('node-offline'))).toBe(true)
  })

  it('returns false for capRouteReason === "transport-failed"', () => {
    expect(isAbsentProvider(makeTypedError('transport-failed'))).toBe(false)
  })

  it('returns false for capRouteReason === "cap-unknown"', () => {
    expect(isAbsentProvider(makeTypedError('cap-unknown'))).toBe(false)
  })

  // ── Substring fallback ────────────────────────────────────────────────────

  it('falls back to substring match when capRouteReason is absent — "provider not available"', () => {
    expect(isAbsentProvider(makeLegacyError('Capability "ptz" provider not available'))).toBe(true)
  })

  it('returns false for a generic error with no capRouteReason and no matching substring', () => {
    expect(isAbsentProvider(makeLegacyError('socket closed unexpectedly'))).toBe(false)
  })

  it('returns false for a non-Error unknown value without capRouteReason', () => {
    expect(isAbsentProvider('some string error')).toBe(false)
    expect(isAbsentProvider({ code: 500 })).toBe(false)
    expect(isAbsentProvider(null)).toBe(false)
    expect(isAbsentProvider(undefined)).toBe(false)
  })

  // ── Typed path takes precedence over substring ────────────────────────────

  it('uses typed reason even when message also matches legacy substring', () => {
    // capRouteReason='transport-failed' but message says "provider not available"
    const err = new Error('Capability "ptz" provider not available')
    Object.assign(err, { data: { capRouteReason: 'transport-failed' } })
    // Typed reason wins → should be false (real error, not absent)
    expect(isAbsentProvider(err)).toBe(false)
  })
})
