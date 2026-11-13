import { describe, expect, it } from 'vitest'
import { type SourceDestination, sourceSearchRequires } from '../source-selector-model'

const LEVEL: SourceDestination = {
  cap: 'consumables',
  targetId: 'items',
  fieldPath: 'level',
  title: 'Level',
}

describe('what the source column asks the device search', () => {
  it('requires the caps that can feed a destination with declared sources', () => {
    const search = sourceSearchRequires(LEVEL)
    expect(search.kind).toBe('requires')
    if (search.kind !== 'requires') return
    expect(search.requires.mode).toBe('any')
    expect((search.requires.caps ?? []).length).toBeGreaterThan(0)
  })

  it('offers nothing, and runs no search, for a destination with no source', () => {
    // An empty `requires.caps` makes every device compatible on the hub, so it
    // must never be sent for "nothing can feed this".
    expect(sourceSearchRequires({ cap: 'no-such-cap', targetId: 'none', title: 'None' })).toEqual({
      kind: 'none',
    })
  })

  it('asks for every device when any field is accepted or a picker target fits', () => {
    expect(sourceSearchRequires({ ...LEVEL, acceptAnyField: true })).toEqual({ kind: 'all' })
    expect(sourceSearchRequires({ ...LEVEL, pickerTargetKind: 'number' })).toEqual({
      kind: 'all',
    })
  })
})
