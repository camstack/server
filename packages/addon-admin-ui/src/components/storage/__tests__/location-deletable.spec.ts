import type { StorageLocation } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { locationDeletable } from '../location-deletable'

const BASE: StorageLocation = {
  id: 'recordings:nvme',
  type: 'recordings',
  displayName: 'NVMe',
  providerId: 'filesystem',
  config: { basePath: '/mnt/nvme/rec' },
  nodeId: 'agent-1',
  isSystem: false,
  enabled: false,
  createdAt: 1,
  updatedAt: 2,
}

describe('locationDeletable', () => {
  const ssd: StorageLocation = { ...BASE, id: 'recordings:ssd', enabled: true }
  const frozen: StorageLocation = { ...BASE, id: 'recordings:hdd', enabled: false }

  it('lets a frozen location go when a writable sibling remains', () => {
    expect(locationDeletable(frozen, [ssd, frozen], 'multi')).toBe(true)
  })

  it('never deletes the only location of a type', () => {
    expect(locationDeletable(ssd, [ssd], 'multi')).toBe(false)
  })

  it('never deletes the only location still taking writes', () => {
    expect(locationDeletable(ssd, [ssd, frozen], 'multi')).toBe(false)
  })

  it('never deletes a single-cardinality location', () => {
    expect(locationDeletable(ssd, [ssd, frozen], 'single')).toBe(false)
  })
})
