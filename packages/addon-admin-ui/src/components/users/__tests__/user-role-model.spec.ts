/**
 * The role modal's decisions about what it SAVES (D921).
 *
 *  - "All devices except…" is `allow: '*'`, `block: <picked>`; nothing picked
 *    is every device;
 *  - "Only these devices…" is `allow: <picked>`, `block: []`, and zero ids
 *    cannot be saved;
 *  - switching mode keeps the picked ids;
 *  - a stored allow-list plus a block reads as "only" with the block removed.
 */
import { describe, expect, it } from 'vitest'

import {
  draftFromUser,
  invalidReasonOf,
  saveRequestOf,
  withFeature,
  withMode,
  withPickedIds,
  withRole,
} from '../user-role-model'

describe('draftFromUser', () => {
  it('reads an admin as Admin, keeping a default except-list for a switch back', () => {
    const d = draftFromUser({ isAdmin: true, scopes: [] })
    expect(d.role).toBe('admin')
    expect(d.mode).toBe('except')
    expect(d.viewer.allow).toBe('*')
    expect(d.unconfigured).toBe(false)
  })

  it('reads allow * and a block as "except" with those ids', () => {
    const d = draftFromUser({
      isAdmin: false,
      scopes: [{ type: 'viewer', allow: '*', block: [11, 20], features: ['scenes'] }],
    })
    expect(d.mode).toBe('except')
    expect(d.pickedIds).toEqual([11, 20])
    expect(saveRequestOf(d)?.scopes).toEqual([
      { type: 'viewer', allow: '*', block: [11, 20], features: ['scenes'] },
    ])
  })

  it('reads an allow list as "only" with those ids and an empty block', () => {
    const d = draftFromUser({
      isAdmin: false,
      scopes: [{ type: 'viewer', allow: [1, 2], block: [], features: [] }],
    })
    expect(d.mode).toBe('only')
    expect(d.pickedIds).toEqual([1, 2])
    expect(d.viewer).toEqual({ type: 'viewer', allow: [1, 2], block: [], features: [] })
  })

  it('reads an allow list plus a block as "only" with the block subtracted', () => {
    const d = draftFromUser({
      isAdmin: false,
      scopes: [{ type: 'viewer', allow: [1, 2, 11], block: [11, 99], features: ['retrain'] }],
    })
    expect(d.mode).toBe('only')
    expect(d.pickedIds).toEqual([1, 2])
    expect(saveRequestOf(d)?.scopes).toEqual([
      { type: 'viewer', allow: [1, 2], block: [], features: ['retrain'] },
    ])
  })

  it('opens an unconfigured non-admin as "except" with nothing picked', () => {
    const d = draftFromUser({ isAdmin: false, scopes: [] })
    expect(d.role).toBe('viewer')
    expect(d.unconfigured).toBe(true)
    expect(d.mode).toBe('except')
    expect(saveRequestOf(d)?.scopes).toEqual([
      { type: 'viewer', allow: '*', block: [], features: [] },
    ])
  })

  it('ignores a stored grant set that is not a viewer row', () => {
    const d = draftFromUser({
      isAdmin: false,
      scopes: [{ type: 'category', target: 'device', access: ['view'] }],
    })
    expect(d.role).toBe('viewer')
    expect(d.unconfigured).toBe(true)
    expect(d.mode).toBe('except')
  })
})

describe('mode switch', () => {
  it('keeps the picked ids and only changes what they mean', () => {
    const except = withPickedIds(draftFromUser({ isAdmin: false, scopes: [] }), [2, 1, 2])
    expect(saveRequestOf(except)?.scopes).toEqual([
      { type: 'viewer', allow: '*', block: [2, 1], features: [] },
    ])
    const only = withMode(except, 'only')
    expect(only.pickedIds).toEqual([2, 1])
    expect(saveRequestOf(only)?.scopes).toEqual([
      { type: 'viewer', allow: [2, 1], block: [], features: [] },
    ])
    const back = withMode(only, 'except')
    expect(back.pickedIds).toEqual([2, 1])
    expect(saveRequestOf(back)?.scopes).toEqual([
      { type: 'viewer', allow: '*', block: [2, 1], features: [] },
    ])
  })

  it('"only" with zero ids cannot be saved', () => {
    const only = withMode(draftFromUser({ isAdmin: false, scopes: [] }), 'only')
    expect(only.pickedIds).toEqual([])
    expect(invalidReasonOf(only)).toBe('no-allowed-device')
    expect(saveRequestOf(only)).toBeNull()
    const picked = withPickedIds(only, [3])
    expect(invalidReasonOf(picked)).toBeNull()
  })
})

describe('role switch', () => {
  it('Admin saves isAdmin with no scopes; switching back restores the viewer row', () => {
    const viewer = draftFromUser({
      isAdmin: false,
      scopes: [{ type: 'viewer', allow: '*', block: [3], features: [] }],
    })
    expect(saveRequestOf(withRole(viewer, 'admin'))).toEqual({ isAdmin: true, scopes: [] })
    const back = withRole(withRole(viewer, 'admin'), 'viewer')
    expect(saveRequestOf(back)?.scopes).toEqual([
      { type: 'viewer', allow: '*', block: [3], features: [] },
    ])
  })
})

describe('features', () => {
  it('grants and withdraws one feature at a time, never duplicating', () => {
    const start = draftFromUser({ isAdmin: false, scopes: [] })
    const on = withFeature(withFeature(start, 'face-assignment', true), 'face-assignment', true)
    expect(on.viewer.features).toEqual(['face-assignment'])
    const two = withFeature(on, 'retrain', true)
    expect(withFeature(two, 'face-assignment', false).viewer.features).toEqual(['retrain'])
  })
})
