import { describe, it, expect } from 'vitest'
import { isTransientQueryError, transientRefetchInterval } from '../transient-error'

function capError(reason: string): Error {
  return Object.assign(new Error('x'), { data: { capRouteReason: reason } })
}

describe('isTransientQueryError', () => {
  it('treats a provider that is away or being respawned as transient', () => {
    expect(isTransientQueryError(capError('node-offline'), 1)).toBe(true)
    expect(isTransientQueryError(capError('no-provider'), 1)).toBe(true)
    expect(isTransientQueryError(capError('transport-failed'), 1)).toBe(true)
    expect(isTransientQueryError(new Error('provider not available'), 1)).toBe(true)
    expect(isTransientQueryError(new TypeError('Failed to fetch'), 1)).toBe(true)
  })
  it('keeps a real error an error', () => {
    expect(isTransientQueryError(new Error('Integration int_x not found'), 1)).toBe(false)
    expect(isTransientQueryError(capError('cap-unknown'), 1)).toBe(false)
    expect(isTransientQueryError(null, 1)).toBe(false)
  })
  it('stops calling a failure transient once it has lasted past the bound', () => {
    expect(isTransientQueryError(capError('node-offline'), 1000)).toBe(false)
  })
})

describe('transientRefetchInterval', () => {
  it('polls while the error is transient and not otherwise', () => {
    const base = { dataUpdatedAt: 0 }
    expect(
      transientRefetchInterval({
        state: { ...base, error: capError('node-offline'), errorUpdateCount: 1 },
      }),
    ).toBeGreaterThan(0)
    expect(
      transientRefetchInterval({
        state: { ...base, error: new Error('nope'), errorUpdateCount: 1 },
      }),
    ).toBe(false)
    expect(transientRefetchInterval({ state: { ...base, error: null, errorUpdateCount: 0 } })).toBe(
      false,
    )
  })
})
