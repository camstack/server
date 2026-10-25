import { describe, expect, it } from 'vitest'
import { DreameFacadeResolver } from '../dreame-gateway.js'

/**
 * The shared per-broker `stateChanged` fan-out bus. Accessory children
 * subscribe here instead of attaching directly to the nodedreame device
 * handle's EventEmitter — a robot container with dozens of children would
 * otherwise trip Node's default MaxListeners cap (one listener per child on a
 * single emitter, the `[provider-dreame] MaxListenersExceededWarning`).
 */
describe('DreameFacadeResolver stateChanged fan-out bus', () => {
  it('delivers a pump tick only to subscribers of the matching (broker, device)', () => {
    const resolver = new DreameFacadeResolver()
    const calls: string[] = []
    resolver.onStateChanged('b1', 'dev1', () => calls.push('b1:dev1'))
    resolver.onStateChanged('b1', 'dev2', () => calls.push('b1:dev2'))
    resolver.onStateChanged('b2', 'dev1', () => calls.push('b2:dev1'))

    resolver.emitStateChanged('b1', 'dev1')

    expect(calls).toEqual(['b1:dev1'])
  })

  it('fans one tick out to every subscriber of the same device', () => {
    const resolver = new DreameFacadeResolver()
    const calls: string[] = []
    resolver.onStateChanged('b1', 'dev1', () => calls.push('child-a'))
    resolver.onStateChanged('b1', 'dev1', () => calls.push('child-b'))

    resolver.emitStateChanged('b1', 'dev1')

    expect(calls.sort()).toEqual(['child-a', 'child-b'])
  })

  it('stops delivering after unsubscribe (repeated cycles do not accumulate)', () => {
    const resolver = new DreameFacadeResolver()
    let calls = 0
    // Simulate repeated activate/remove cycles — the leak class this bus fixes.
    for (let i = 0; i < 50; i += 1) {
      const unsub = resolver.onStateChanged('b1', 'dev1', () => {
        calls += 1
      })
      unsub()
    }
    resolver.emitStateChanged('b1', 'dev1')
    expect(calls).toBe(0)

    const live = resolver.onStateChanged('b1', 'dev1', () => {
      calls += 1
    })
    resolver.emitStateChanged('b1', 'dev1')
    expect(calls).toBe(1)
    live()
  })

  it('a throwing subscriber does not starve the others', () => {
    const resolver = new DreameFacadeResolver()
    let survived = false
    resolver.onStateChanged('b1', 'dev1', () => {
      throw new Error('bad subscriber')
    })
    resolver.onStateChanged('b1', 'dev1', () => {
      survived = true
    })

    expect(() => resolver.emitStateChanged('b1', 'dev1')).not.toThrow()
    expect(survived).toBe(true)
  })

  it('emitting for a device with no subscribers is a no-op', () => {
    const resolver = new DreameFacadeResolver()
    expect(() => resolver.emitStateChanged('b1', 'nobody')).not.toThrow()
  })

  it('clear() drops all subscriptions (full shutdown)', () => {
    const resolver = new DreameFacadeResolver()
    let calls = 0
    resolver.onStateChanged('b1', 'dev1', () => {
      calls += 1
    })

    resolver.clear()
    resolver.emitStateChanged('b1', 'dev1')

    expect(calls).toBe(0)
  })
})
