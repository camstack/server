// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  identityDirty,
  identitySaveRefusal,
  quickDetailSaveState,
  seedIdentityDraft,
} from '../identity-draft'

describe('quick-detail identity draft', () => {
  it('seeds from the server and stays clean until an edit', () => {
    const seeded = seedIdentityDraft(null, 'Kitchen', 'Hall')
    expect(identityDirty(seeded)).toBe(false)
    const edited = { ...seeded, name: 'Pantry' }
    expect(identityDirty(edited)).toBe(true)
    expect(seedIdentityDraft(edited, 'Kitchen', 'Hall')).toEqual(edited)
  })

  it('follows a server refresh that matches the draft', () => {
    const dirty = seedIdentityDraft(null, 'Kitchen', 'Hall')
    const edited = { ...dirty, location: 'Utility' }
    expect(seedIdentityDraft(edited, 'Kitchen', 'Utility')).toEqual({
      name: 'Kitchen',
      location: 'Utility',
      baseName: 'Kitchen',
      baseLocation: 'Utility',
    })
  })

  it('refuses a blank name and joins section errors', () => {
    const draft = seedIdentityDraft(null, 'Kitchen', '')
    expect(identitySaveRefusal({ ...draft, name: '  ' })).toBe('name')
    expect(identitySaveRefusal(draft)).toBeNull()
    expect(
      quickDetailSaveState([
        { dirty: false, saving: false, error: null },
        { dirty: true, saving: true, error: 'refused' },
      ]),
    ).toEqual({ dirty: true, saving: true, error: 'refused' })
    expect(quickDetailSaveState([{ dirty: false, saving: false, error: null }])).toEqual({
      dirty: false,
      saving: false,
      error: null,
    })
  })
})
