/**
 * `INFRA_CAPABILITIES` is an ORDERED list — Phase 1 of boot walks it in
 * sequence and initializes the addon providing each entry. The order is
 * therefore a dependency declaration, and nothing else in the system
 * enforces it.
 *
 * This exists because the data door (D44) made the order load-bearing in a
 * way it was not before: `storage-orchestrator` serves BOTH `storage` and
 * `settings-store`, and hydrates its own location table through the
 * `data-store-provider` engine. Boot it before the engine exists and it
 * silently runs in-memory — operator location edits live only in RAM and
 * vanish on restart, which is the failure the late-wire fallback was
 * written for and should not be relied on.
 *
 * A unit test cannot prove the hub boots (that needs the native sqlite
 * binding, and a real data dir). What it can do is pin the ordering
 * someone would otherwise reshuffle while tidying the list.
 */
import { describe, it, expect } from 'vitest'
import { INFRA_CAPABILITIES } from '../infra-capabilities.js'

const indexOf = (name: string): number => INFRA_CAPABILITIES.findIndex((c) => c.name === name)

describe('INFRA_CAPABILITIES ordering', () => {
  it('lists the data engine before the door that dispatches to it', () => {
    const engine = indexOf('data-store-provider')
    const door = indexOf('settings-store')
    expect(engine).toBeGreaterThanOrEqual(0)
    expect(door).toBeGreaterThanOrEqual(0)
    expect(engine).toBeLessThan(door)
  })

  it('lists the data engine before `storage`, whose owner also owns the door', () => {
    expect(indexOf('data-store-provider')).toBeLessThan(indexOf('storage'))
  })

  it('lists the byte provider before the `storage` orchestrator', () => {
    expect(indexOf('storage-provider')).toBeLessThan(indexOf('storage'))
  })

  it('marks both halves of the data path required — a missing one must abort boot', () => {
    for (const name of ['data-store-provider', 'settings-store']) {
      expect(INFRA_CAPABILITIES.find((c) => c.name === name)?.required).toBe(true)
    }
  })
})
