import { StaleStampError } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { staleBlockRefusal } from '../block-stamp.js'

const STORED = { name: 'Porch', updatedAt: 200 }

describe('core block write stamp', () => {
  it('refuses a save whose stamp is not the stored one, with the typed error', () => {
    const refusal = staleBlockRefusal(STORED, 100)
    expect(refusal).toBeInstanceOf(StaleStampError)
    expect(refusal?.message).toMatch(/^\[stale-stamp\] the block "Porch"/)
    expect(refusal).toMatchObject({ stored: 200, expected: 100 })
  })

  it('lets a fresh stamp, no stamp, and a missing block through', () => {
    expect(staleBlockRefusal(STORED, 200)).toBeNull()
    expect(staleBlockRefusal(STORED, undefined)).toBeNull()
    expect(staleBlockRefusal(null, 100)).toBeNull()
  })
})
