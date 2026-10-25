/**
 * D476 guard: `MediaStore.OWNER_KINDS` (the AUTHORITY on what may own media)
 * must stay a SUBSET of `@camstack/types`' `MEDIA_OWNER_TYPES` (the codec's
 * list, which `parseMediaOwnerKey` accepts).
 *
 * The codec's list was built from the prefixes actually present on the live
 * hub, which is how `vehicle` and `scene` were nearly left out — both are
 * declared owner kinds with zero media rows today, so nothing in production
 * traffic would have caught the omission, and the parser would have rejected
 * their keys the day either owner kind wrote its first row. A list derived
 * from data is correct only until the data changes; this guard is what keeps
 * `MEDIA_OWNER_TYPES` married to `OWNER_KINDS` from here on — add a member to
 * one without the other and this test fails immediately, in CI, rather than
 * waiting for the first key that owner kind writes.
 */
import { MEDIA_OWNER_TYPES } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { OWNER_KINDS } from '../media-store.js'

describe('OWNER_KINDS ⊆ MEDIA_OWNER_TYPES', () => {
  it('every media owner kind the store may write is one the codec can parse back', () => {
    const parseable = new Set<string>(MEDIA_OWNER_TYPES)
    const missing = OWNER_KINDS.filter((kind) => !parseable.has(kind))
    expect(missing).toEqual([])
  })

  it('the store never re-admits the retired `event` owner kind', () => {
    expect(OWNER_KINDS).not.toContain('event')
    expect(MEDIA_OWNER_TYPES).not.toContain('event')
  })
})
