/**
 * Provider entry helpers for Modal: normalise an entry.
 */
import { describe, expect, it } from 'vitest'
import { normalizeModalEntry } from '../modal-entries.js'

describe('modal entry helpers', () => {
  it('normalizeModalEntry fills omitted secret fields so describe can trim', () => {
    const entry = normalizeModalEntry({ id: 'e-1', name: 'Bare', tokenId: 'ak' })
    expect(entry.tokenSecret).toBe('')
    expect(entry.environment).toBe('')
    expect(typeof entry.tokenSecret === 'string' ? entry.tokenSecret.trim() : 'x').toBe('')
  })
})
