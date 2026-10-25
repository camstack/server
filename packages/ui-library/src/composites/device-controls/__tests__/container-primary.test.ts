import { describe, it, expect } from 'vitest'
import {
  resolveContainerPrimary,
  overrideEntityIdFromLink,
  containerChildToRef,
  childEntityId,
  type ContainerChild,
} from '../container-primary'

// A lock + a battery sensor under a container, mirroring the container-link-v2
// mockup (a lock-container resolves to the lock).
const battery: ContainerChild = {
  id: 7,
  stableId: 'st-batt',
  type: 'sensor',
  sourceInfo: { id: 'sensor.batt' },
}
const lock: ContainerChild = {
  id: 9,
  stableId: 'st-lock',
  type: 'lock',
  sourceInfo: { id: 'lock.front' },
}
const children: readonly ContainerChild[] = [battery, lock]

describe('childEntityId', () => {
  it('prefers sourceInfo.id', () => {
    expect(childEntityId(battery)).toBe('sensor.batt')
  })

  it('falls back to stableId when sourceInfo is absent', () => {
    expect(childEntityId({ id: 1, stableId: 'st-x', type: 'switch' })).toBe('st-x')
  })
})

describe('containerChildToRef', () => {
  it('projects a raw child row onto the resolver ChildRef shape', () => {
    expect(containerChildToRef(lock)).toEqual({ id: 9, entityId: 'lock.front', type: 'lock' })
  })
})

describe('overrideEntityIdFromLink', () => {
  it('returns undefined when no link is set', () => {
    expect(overrideEntityIdFromLink(children, null)).toBeUndefined()
    expect(overrideEntityIdFromLink(children, undefined)).toBeUndefined()
  })

  it('resolves a linked numeric id to its stable entityId', () => {
    expect(overrideEntityIdFromLink(children, 7)).toBe('sensor.batt')
  })

  it('returns undefined for a stale link (numeric id no longer present)', () => {
    expect(overrideEntityIdFromLink(children, 999)).toBeUndefined()
  })
})

describe('resolveContainerPrimary', () => {
  it('defaults to the highest-priority child (lock > sensor)', () => {
    expect(resolveContainerPrimary(children, null)?.id).toBe(9)
  })

  it('honors the picker override stored on linkDeviceId', () => {
    // operator picked the battery sensor → linkDeviceId = 7
    expect(resolveContainerPrimary(children, 7)?.id).toBe(7)
  })

  it('falls back to the priority default when the link is stale after re-sync', () => {
    // re-sync reallocated ids; linkDeviceId 7 no longer exists → default = lock
    expect(resolveContainerPrimary(children, 7000)?.id).toBe(9)
  })

  it('loses the override (graceful fallback) when a re-sync reallocates the linked numeric id', () => {
    // After re-sync the battery sensor kept its entityId but got a NEW numeric
    // id. The container's linkDeviceId still points at the OLD numeric id (7),
    // which is now stale → resolver falls back to priority default (lock).
    const afterResync: readonly ContainerChild[] = [
      { id: 70, stableId: 'st-batt', type: 'sensor', sourceInfo: { id: 'sensor.batt' } },
      { id: 90, stableId: 'st-lock', type: 'lock', sourceInfo: { id: 'lock.front' } },
    ]
    expect(resolveContainerPrimary(afterResync, 7)?.id).toBe(90)
    // ...but once the link is migrated to the new numeric id, the override holds.
    expect(resolveContainerPrimary(afterResync, 70)?.id).toBe(70)
  })

  it('returns null for a container with no children (degrades gracefully)', () => {
    expect(resolveContainerPrimary([], null)).toBeNull()
    expect(resolveContainerPrimary([], 5)).toBeNull()
  })

  describe('durable primaryChildEntityId override', () => {
    it('honors the entityId override over the priority default', () => {
      // operator picked the battery sensor by entityId → wins over lock default
      expect(resolveContainerPrimary(children, null, 'sensor.batt')?.id).toBe(7)
    })

    it('entityId override wins over a conflicting numeric linkDeviceId', () => {
      // linkDeviceId points at the lock (9) but the durable override picks the sensor
      expect(resolveContainerPrimary(children, 9, 'sensor.batt')?.id).toBe(7)
    })

    it('survives a re-sync that reallocates numeric ids (entityId stable)', () => {
      const afterResync: readonly ContainerChild[] = [
        { id: 70, stableId: 'st-batt', type: 'sensor', sourceInfo: { id: 'sensor.batt' } },
        { id: 90, stableId: 'st-lock', type: 'lock', sourceInfo: { id: 'lock.front' } },
      ]
      // numeric link 7 is stale, but the entityId override still resolves
      expect(resolveContainerPrimary(afterResync, 7, 'sensor.batt')?.id).toBe(70)
    })

    it('falls back to linkDeviceId when no entityId override is given', () => {
      expect(resolveContainerPrimary(children, 7, undefined)?.id).toBe(7)
      expect(resolveContainerPrimary(children, 7, null)?.id).toBe(7)
    })

    it('falls back to priority default when the entityId override matches no child', () => {
      expect(resolveContainerPrimary(children, null, 'cover.ghost')?.id).toBe(9)
    })
  })
})
