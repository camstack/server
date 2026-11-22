import { describe, expect, it } from 'vitest'
import { KiaVehicleHandle } from '../kia-device-handle.js'
import { KiaConnectionResolver, type KiaConnectionSurface } from '../kia-gateway.js'
import { sportageState } from './kia-fixtures.js'

function handle(): KiaVehicleHandle {
  return new KiaVehicleHandle('veh-1', sportageState(), {
    requestRefresh: async () => ({ ok: false, reason: 'account-error', retryAt: null }),
    command: async () => ({ outcome: 'success', state: sportageState() }),
  })
}

function surfaceOf(h: KiaVehicleHandle): KiaConnectionSurface {
  return { infos: [], handles: new Map([['veh-1', h]]), refresh: async () => undefined }
}

/**
 * The device classes are activated once, often before the first sign-in succeeded, and the
 * manager builds NEW handles on every start. A watcher must follow the vehicle across both.
 */
describe('watching a vehicle across connections', () => {
  it('delivers a change of a handle that did not exist when the watch began', () => {
    const resolver = new KiaConnectionResolver()
    let seen = 0
    resolver.watchVehicle('acct', 'veh-1', () => void (seen += 1))
    const first = handle()
    resolver.set('acct', surfaceOf(first))
    const afterConnect = seen
    expect(afterConnect).toBeGreaterThan(0)
    first.update(sportageState({ odometerM: 1 }))
    expect(seen).toBe(afterConnect + 1)
  })

  it('follows the vehicle to a new handle after a reconnect and lets go of the old one', () => {
    const resolver = new KiaConnectionResolver()
    let seen = 0
    resolver.watchVehicle('acct', 'veh-1', () => void (seen += 1))
    const first = handle()
    resolver.set('acct', surfaceOf(first))
    resolver.set('acct', null)
    const second = handle()
    resolver.set('acct', surfaceOf(second))
    const before = seen
    second.update(sportageState({ odometerM: 2 }))
    expect(seen).toBe(before + 1)
    first.update(sportageState({ odometerM: 3 }))
    expect(seen).toBe(before + 1)
  })

  it('stops delivering after the watch is cancelled', () => {
    const resolver = new KiaConnectionResolver()
    let seen = 0
    const cancel = resolver.watchVehicle('acct', 'veh-1', () => void (seen += 1))
    const h = handle()
    resolver.set('acct', surfaceOf(h))
    cancel()
    const before = seen
    h.update(sportageState({ odometerM: 4 }))
    resolver.set('acct', surfaceOf(handle()))
    expect(seen).toBe(before)
  })
})
