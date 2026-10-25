import { describe, it, expect } from 'vitest'
import { setBrokerDevicesOnline, type OfflineTarget } from '../homematic-broker-offline.js'

// ---------------------------------------------------------------------------
// Test factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal `OfflineTarget`-shaped fake. `markOnline` mutates the
 * object's `online` field directly so assertions can read it back without
 * any getters or closures.
 */
function makeFake(brokerId: string, online: boolean): OfflineTarget & { online: boolean } {
  const fake = {
    online,
    config: {
      get(key: string): unknown {
        return key === 'brokerId' ? brokerId : undefined
      },
    },
    markOnline(v: boolean): void {
      fake.online = v
    },
  }
  return fake
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setBrokerDevicesOnline', () => {
  it('marks only devices matching brokerId offline and returns the count', () => {
    const a = makeFake('hm_001', true)
    const b = makeFake('hm_001', true)
    const c = makeFake('hm_002', true) // different broker — must not change

    const count = setBrokerDevicesOnline([a, b, c], 'hm_001', false)

    expect(count).toBe(2)
    expect(a.online).toBe(false)
    expect(b.online).toBe(false)
    expect(c.online).toBe(true) // untouched
  })

  it('skips devices already in the target state (no-op, churn-free)', () => {
    const a = makeFake('hm_001', false) // already offline
    const b = makeFake('hm_001', true) // needs to go offline

    const count = setBrokerDevicesOnline([a, b], 'hm_001', false)

    expect(count).toBe(1) // only b was changed
    expect(a.online).toBe(false)
    expect(b.online).toBe(false)
  })

  it('brings matching devices back online when online=true', () => {
    const a = makeFake('hm_001', false)
    const b = makeFake('hm_001', false)
    const c = makeFake('hm_002', false) // different broker — untouched

    const count = setBrokerDevicesOnline([a, b, c], 'hm_001', true)

    expect(count).toBe(2)
    expect(a.online).toBe(true)
    expect(b.online).toBe(true)
    expect(c.online).toBe(false) // untouched
  })

  it('returns 0 and changes nothing when no device matches brokerId', () => {
    const a = makeFake('hm_002', true)
    const b = makeFake('hm_003', true)

    const count = setBrokerDevicesOnline([a, b], 'hm_001', false)

    expect(count).toBe(0)
    expect(a.online).toBe(true)
    expect(b.online).toBe(true)
  })

  it('returns 0 for an empty device list', () => {
    const count = setBrokerDevicesOnline([], 'hm_001', false)
    expect(count).toBe(0)
  })
})
