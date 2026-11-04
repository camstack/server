import { describe, expect, it } from 'vitest'
import { REOLINK_INTEGRATION_MIGRATIONS, REOLINK_MIGRATIONS } from '../migrations/index.js'

describe('provider-reolink migration catalogue', () => {
  it('is declared in increasing seq order, as the engine requires before anything runs', () => {
    // The order addon.ts offers the catalogue in: the settings wave, then the integration wave.
    const seqs = [...REOLINK_MIGRATIONS, ...REOLINK_INTEGRATION_MIGRATIONS].map((m) => m.meta.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })
})
