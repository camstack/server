/**
 * The ledger walk refuses a location that is still a write target
 * (`enabled !== false` and not `config.readOnly`). The picker must use the
 * SAME predicate, or the UI offers a Report that comes back `source-writable`.
 */

import type { StorageLocation } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { footageLocationFrozen } from '../footage-location-frozen.js'

function loc(patch: Partial<StorageLocation> & Pick<StorageLocation, 'id'>): StorageLocation {
  return {
    type: 'recordingsLow',
    displayName: patch.id,
    providerId: 'fs',
    config: {},
    isSystem: false,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

describe('footageLocationFrozen', () => {
  it('a live default is not frozen', () => {
    expect(footageLocationFrozen(loc({ id: 'recordings:default' }))).toBe(false)
  })

  it('disabled is frozen — the drain flag that recordingsLow:default already has', () => {
    expect(footageLocationFrozen(loc({ id: 'recordingsLow:default', enabled: false }))).toBe(true)
  })

  it('config.readOnly is frozen — the other drain flag', () => {
    expect(footageLocationFrozen(loc({ id: 'recordings:old', config: { readOnly: true } }))).toBe(
      true,
    )
  })

  it('enabled:true with no readOnly is live, even if config has other keys', () => {
    expect(
      footageLocationFrozen(loc({ id: 'recordings:ssd', enabled: true, config: { path: '/x' } })),
    ).toBe(false)
  })
})
