import { describe, it, expect } from 'vitest'
import {
  setIntegrationDevicesOnline,
  type OfflineTarget,
} from '../homematic-integration-offline.js'

// ---------------------------------------------------------------------------
// Test factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal `OfflineTarget`-shaped fake. `markOnline` mutates the
 * object's `online` field directly so assertions can read it back without
 * any getters or closures.
 */
function makeFake(integrationId: string, online: boolean): OfflineTarget & { online: boolean } {
  const fake = {
    online,
    config: {
      get(key: string): unknown {
        return key === 'integrationId' ? integrationId : undefined
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

describe('setIntegrationDevicesOnline', () => {
  it('marks only devices matching integrationId offline and returns the count', () => {
    const a = makeFake('int-1', true)
    const b = makeFake('int-1', true)
    const c = makeFake('int-2', true) // different integration — must not change

    const count = setIntegrationDevicesOnline([a, b, c], 'int-1', false)

    expect(count).toBe(2)
    expect(a.online).toBe(false)
    expect(b.online).toBe(false)
    expect(c.online).toBe(true) // untouched
  })

  it('skips devices already in the target state (no-op, churn-free)', () => {
    const a = makeFake('int-1', false) // already offline
    const b = makeFake('int-1', true) // needs to go offline

    const count = setIntegrationDevicesOnline([a, b], 'int-1', false)

    expect(count).toBe(1) // only b was changed
    expect(a.online).toBe(false)
    expect(b.online).toBe(false)
  })

  it('brings matching devices back online when online=true', () => {
    const a = makeFake('int-1', false)
    const b = makeFake('int-1', false)
    const c = makeFake('int-2', false) // different integration — untouched

    const count = setIntegrationDevicesOnline([a, b, c], 'int-1', true)

    expect(count).toBe(2)
    expect(a.online).toBe(true)
    expect(b.online).toBe(true)
    expect(c.online).toBe(false) // untouched
  })

  it('returns 0 and changes nothing when no device matches integrationId', () => {
    const a = makeFake('int-2', true)
    const b = makeFake('hm_003', true)

    const count = setIntegrationDevicesOnline([a, b], 'int-1', false)

    expect(count).toBe(0)
    expect(a.online).toBe(true)
    expect(b.online).toBe(true)
  })

  it('returns 0 for an empty device list', () => {
    const count = setIntegrationDevicesOnline([], 'int-1', false)
    expect(count).toBe(0)
  })
})

describe('setIntegrationDevicesOnline: what it keys on', () => {
  it('flips a child that carries only the integration id (no system marker)', () => {
    const child = makeFake('int-1', true)
    expect(setIntegrationDevicesOnline([child], 'int-1', false)).toBe(1)
    expect(child.online).toBe(false)
  })

  it('leaves a device of no integration alone', () => {
    const orphan: OfflineTarget & { online: boolean } = {
      online: true,
      config: { get: (): unknown => undefined },
      markOnline(v: boolean): void {
        orphan.online = v
      },
    }
    expect(setIntegrationDevicesOnline([orphan], 'int-1', false)).toBe(0)
    expect(orphan.online).toBe(true)
  })
})
