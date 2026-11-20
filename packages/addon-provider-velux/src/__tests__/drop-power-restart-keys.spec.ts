import { describe, expect, it } from 'vitest'
import {
  type DropPowerRestartKeysPorts,
  dropPowerRestartKeys,
  VELUX_DROP_POWER_RESTART_KEYS_MIGRATION,
} from '../migrations/drop-power-restart-keys.js'

function store(initial: Record<string, unknown>): {
  readonly ports: DropPowerRestartKeysPorts
  readonly now: () => Record<string, unknown>
} {
  const data: Record<string, unknown> = { ...initial }
  return {
    ports: {
      storedKeys: async () => Object.keys(data),
      deleteKeys: async (keys) => {
        for (const key of keys) delete data[key]
      },
    },
    now: () => ({ ...data }),
  }
}

describe('dropping the retired power restart keys', () => {
  it('removes every powerRestartAt:<integration> key and nothing else', async () => {
    const s = store({
      'powerRestartAt:int_0037': 1_795_000_000_000,
      'powerRestartAt:int_0040': 1_795_000_100_000,
      lastScan: 5,
    })
    const result = await dropPowerRestartKeys(s.ports)
    expect(result).toEqual({ outcome: 'done', summary: { removed: 2 } })
    expect(s.now()).toEqual({ lastScan: 5 })
  })

  it('a second run finds nothing to do', async () => {
    const s = store({ 'powerRestartAt:int_0037': 1, other: true })
    await dropPowerRestartKeys(s.ports)
    expect(await dropPowerRestartKeys(s.ports)).toEqual({
      outcome: 'already-done',
      summary: { removed: 0 },
    })
    expect(s.now()).toEqual({ other: true })
  })

  it('fails when a key survives the removal', async () => {
    const stuck: DropPowerRestartKeysPorts = {
      storedKeys: async () => ['powerRestartAt:int_0037'],
      deleteKeys: async () => {},
    }
    await expect(dropPowerRestartKeys(stuck)).rejects.toThrow(/still stored/)
  })

  it('is declared as an addon-state migration of provider-velux, marked by its key', () => {
    expect(VELUX_DROP_POWER_RESTART_KEYS_MIGRATION.meta).toMatchObject({
      owner: 'provider-velux',
      store: 'settings',
      fixtureMark: 'powerRestartAt:int_0001',
    })
  })
})
