// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  identityDirty,
  identitySaveRefusal,
  identityWrites,
  quickDetailSaveState,
  seedIdentityDraft,
  type IdentitySeed,
} from '../identity-draft'

const SEED: IdentitySeed = {
  name: 'Kitchen',
  location: 'Hall',
  role: null,
  display: undefined,
}

describe('quick-detail identity draft', () => {
  it('seeds from the server and stays clean until an edit', () => {
    const seeded = seedIdentityDraft(null, SEED)
    expect(identityDirty(seeded)).toBe(false)
    const edited = { ...seeded, name: 'Pantry' }
    expect(identityDirty(edited)).toBe(true)
    expect(seedIdentityDraft(edited, SEED)).toEqual(edited)
  })

  it('follows a server refresh that matches the draft', () => {
    const dirty = seedIdentityDraft(null, SEED)
    const edited = { ...dirty, location: 'Utility' }
    expect(seedIdentityDraft(edited, { ...SEED, location: 'Utility' })).toEqual({
      ...dirty,
      location: 'Utility',
      baseLocation: 'Utility',
    })
  })

  it('refuses a blank name and joins section errors', () => {
    const draft = seedIdentityDraft(null, { ...SEED, location: '' })
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

  it('one save writes only the fields that changed, and an empty display is null', () => {
    const seeded = seedIdentityDraft(null, {
      name: 'Kitchen',
      location: 'Hall',
      role: 'temperature-sensor',
      display: { icon: 'thermometer', perCap: { 'numeric-sensor': { precision: 1 } } },
    })
    expect(identityWrites(seeded)).toEqual({})

    const renamed = { ...seeded, name: 'Pantry' }
    expect(identityWrites(renamed)).toEqual({ name: 'Pantry' })

    const hidden = {
      ...seeded,
      display: { ...seeded.display, hidden: true },
    }
    expect(identityWrites(hidden)).toEqual({
      display: {
        icon: 'thermometer',
        hidden: true,
        perCap: { 'numeric-sensor': { precision: 1 } },
      },
    })

    const cleared = {
      ...seeded,
      display: { icon: '', label: '', unit: '', precision: '', hidden: false },
      persistedDisplay: { icon: 'thermometer' },
    }
    expect(identityWrites(cleared)).toEqual({ display: null })
  })

  it('a role change is its own write and does not touch the display override', () => {
    const seeded = seedIdentityDraft(null, SEED)
    expect(identityWrites({ ...seeded, role: 'siren' })).toEqual({ role: 'siren' })
    expect(identityWrites({ ...seeded, role: 'siren', location: '' })).toEqual({
      role: 'siren',
      location: null,
    })
  })
})
