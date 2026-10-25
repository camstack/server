/**
 * The second and third locks of D296.
 *
 * The first lock (`upsertLocation`) stops the bad configuration from being
 * created. These two hold when it already exists — a row written before the
 * guard, a future code path, or a provider that changes its own answer.
 */
import type { StorageLocation } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { canProbeOccupancyLocally, resolveRefusalFor } from '../access-guards.js'

function location(providerId: string): StorageLocation {
  const now = Date.now()
  return {
    id: 'recordings:nas',
    type: 'recordings',
    displayName: 'NAS',
    providerId,
    config: { basePath: '/backups/camstack' },
    isSystem: false,
    createdAt: now,
    updatedAt: now,
  }
}

describe('storage.resolve on a remote-backed location', () => {
  it('refuses, and says what to use instead', () => {
    const refusal = resolveRefusalFor(location('smb-storage'), false)
    expect(refusal).not.toBeNull()
    expect(refusal).toContain('recordings:nas')
    expect(refusal).toContain('smb-storage')
    expect(refusal).toContain('beginUpload')
  })

  it('permits a node-local provider', () => {
    expect(resolveRefusalFor(location('filesystem-storage'), true)).toBeNull()
  })

  it('permits an unclassified provider rather than refusing on an unmade read', () => {
    expect(resolveRefusalFor(location('not-yet-registered'), undefined)).toBeNull()
  })
})

describe('occupancy: unreachable is not empty', () => {
  it('will not probe a remote-backed location with the local filesystem', () => {
    // `fs.readdir('/backups/camstack')` on the hub answers ENOENT, and ENOENT
    // is deliberately read as `empty`. Letting that reasoning reach a remote
    // row turns a full share into a vacant one and walks D293's delete guard
    // straight past it.
    expect(canProbeOccupancyLocally(false)).toBe(false)
  })

  it('will not probe an unclassified provider either', () => {
    expect(canProbeOccupancyLocally(undefined)).toBe(false)
  })

  it('probes a node-local provider', () => {
    expect(canProbeOccupancyLocally(true)).toBe(true)
  })
})
