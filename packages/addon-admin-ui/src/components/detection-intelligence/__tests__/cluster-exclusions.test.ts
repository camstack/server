import { describe, it, expect } from 'vitest'
import {
  toggleExclusion,
  activeMembers,
  visibleMembers,
  type ClusterView,
} from '../cluster-exclusions.js'

describe('cluster-exclusions', () => {
  describe('toggleExclusion', () => {
    it('adds a faceId not yet excluded', () => {
      const excluded = new Set<string>()
      const next = toggleExclusion(excluded, 'a')
      expect(next.has('a')).toBe(true)
    })

    it('removes a faceId already excluded', () => {
      const excluded = new Set<string>(['a', 'b'])
      const next = toggleExclusion(excluded, 'a')
      expect(next.has('a')).toBe(false)
      expect(next.has('b')).toBe(true)
    })

    it('does not mutate the input set', () => {
      const excluded = new Set<string>(['a'])
      const next = toggleExclusion(excluded, 'b')
      expect(excluded.has('b')).toBe(false)
      expect(next).not.toBe(excluded)
    })

    it('returns a NEW Set instance even when removing', () => {
      const excluded = new Set<string>(['a'])
      const next = toggleExclusion(excluded, 'a')
      expect(next).not.toBe(excluded)
      expect(excluded.has('a')).toBe(true)
    })
  })

  describe('activeMembers', () => {
    const cluster: ClusterView = {
      representativeFaceId: 'a',
      faceIds: ['a', 'b', 'c', 'd'],
      size: 4,
      cohesion: 0.8,
    }

    it('returns all members when nothing is excluded', () => {
      expect(activeMembers(cluster, new Set())).toEqual(['a', 'b', 'c', 'd'])
    })

    it('filters out excluded members while preserving order', () => {
      expect(activeMembers(cluster, new Set(['b']))).toEqual(['a', 'c', 'd'])
    })

    it('returns an empty array when all members are excluded', () => {
      expect(activeMembers(cluster, new Set(['a', 'b', 'c', 'd']))).toEqual([])
    })

    it('ignores excluded ids that are not members of the cluster', () => {
      expect(activeMembers(cluster, new Set(['z']))).toEqual(['a', 'b', 'c', 'd'])
    })
  })

  describe('visibleMembers', () => {
    const cluster: ClusterView = {
      representativeFaceId: 'a',
      faceIds: ['a', 'b', 'c', 'd'],
      size: 4,
      cohesion: 0.8,
    }

    it('returns all members when everything is visible', () => {
      expect(visibleMembers(cluster, () => true)).toEqual(['a', 'b', 'c', 'd'])
    })

    it('drops members outside the visible set while preserving order', () => {
      const loaded = new Set(['a', 'c'])
      expect(visibleMembers(cluster, (id) => loaded.has(id))).toEqual(['a', 'c'])
    })

    it('returns an empty array when nothing is visible', () => {
      expect(visibleMembers(cluster, () => false)).toEqual([])
    })

    it('combines with activeMembers so hidden members are never actionable', () => {
      const loaded = new Set(['a', 'b', 'c'])
      const visible = visibleMembers(cluster, (id) => loaded.has(id))
      const excluded = new Set(['b'])
      // 'd' is outside the loaded window; excludedByCluster can never
      // reference it (the operator never saw a card to exclude), so it must
      // not appear in the action set even though it's a cluster member.
      expect(activeMembers({ ...cluster, faceIds: visible }, excluded)).toEqual(['a', 'c'])
    })
  })
})
