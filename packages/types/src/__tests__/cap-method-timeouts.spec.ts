import { describe, expect, it } from 'vitest'
import { CAP_METHOD_TIMEOUTS_MS } from '../addon.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../generated/capability-router-map.js'
import { ACTION_RUN_MAX_MS, ACTION_RUN_TIMEOUT_MS } from '../capabilities/actions-timeouts.js'

describe('CAP_METHOD_TIMEOUTS_MS', () => {
  it('is exactly what the cap definitions declare', () => {
    const declared: Record<string, Record<string, number>> = {}
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      for (const [name, m] of Object.entries(def.methods ?? {})) {
        if (typeof m.timeoutMs !== 'number') continue
        declared[def.name] = { ...declared[def.name], [name]: m.timeoutMs }
      }
    }
    expect(CAP_METHOD_TIMEOUTS_MS).toEqual(declared)
  })

  it('actions.run outlives the run ceiling and the 60 s transport default', () => {
    const bound = CAP_METHOD_TIMEOUTS_MS['actions']?.['run']
    expect(bound).toBe(ACTION_RUN_TIMEOUT_MS)
    expect(ACTION_RUN_TIMEOUT_MS).toBeGreaterThan(ACTION_RUN_MAX_MS)
    expect(ACTION_RUN_TIMEOUT_MS).toBeGreaterThan(60_000)
  })
})
