/**
 * Two WRITABLE recordings locations of the SAME TYPE over one physical root is
 * a data-integrity hazard, not a preference.
 *
 * Hydrate attributes a discovered segment by PROFILE, and when several aliases
 * of the same type share a root `locationForHydratedProfile` can only pick the
 * lexicographically-first one. So footage written as `recordings:b` reads back
 * as `recordings:a`: per-location accounting, the per-location free-space guard
 * and the relocate mover all then reason about the wrong location, and a drain
 * of `recordings:b` believes it has nothing to move.
 *
 * The guard demotes every alias but the lexicographically-first to READ-ONLY —
 * the same vocabulary the drain model already uses, so placement refuses it
 * with no new branch, the footage stays readable, and the keeper is EXACTLY the
 * alias hydrate attributes to. Stock `recordings:default` + `recordingsLow:default`
 * share a root on purpose and are different TYPES: they must be left alone.
 */
import { describe, expect, it } from 'vitest'
import { demoteWritableAliasConflicts } from '../addon/placement-guard.js'
import {
  type RecordingsLocation,
  resolvePlacement,
  recordingsLocationOfMode,
} from '../addon/roots.js'

const HIGH: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/data/rec' },
  'active',
)
const LOW: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordingsLow:default', type: 'recordingsLow', root: '/data/rec' },
  'active',
)

/** Identity realpath — the roots in these fixtures are already canonical. */
const identity = (p: string): string => p

describe('demoteWritableAliasConflicts', () => {
  it('leaves the stock recordings + recordingsLow pair on one root alone (different types)', () => {
    const result = demoteWritableAliasConflicts([HIGH, LOW], identity)
    expect(result.conflicts).toEqual([])
    expect(result.locations.map((l) => l.readOnly)).toEqual([false, false])
  })

  it('demotes every same-type alias but the lexicographically-first', () => {
    const b: RecordingsLocation = { ...HIGH, id: 'recordings:b' }
    const a: RecordingsLocation = { ...HIGH, id: 'recordings:a' }
    const result = demoteWritableAliasConflicts([b, a], identity)

    expect(result.locations.find((l) => l.id === 'recordings:a')?.readOnly).toBe(false)
    expect(result.locations.find((l) => l.id === 'recordings:b')?.readOnly).toBe(true)
  })

  it('the keeper is the alias hydrate attributes to — placement and hydrate never disagree', () => {
    const aliases: RecordingsLocation[] = [
      { ...HIGH, id: 'recordings:zz' },
      { ...HIGH, id: 'recordings:aa' },
    ]
    const { locations } = demoteWritableAliasConflicts(aliases, identity)
    // `locationForHydratedProfile` sorts by id and takes the first.
    expect(resolvePlacement(locations, 'high').id).toBe('recordings:aa')
  })

  it('reports the conflict with both ids and the shared root, for the log line', () => {
    const aliases: RecordingsLocation[] = [
      { ...HIGH, id: 'recordings:b' },
      { ...HIGH, id: 'recordings:a' },
    ]
    const { conflicts } = demoteWritableAliasConflicts(aliases, identity)
    expect(conflicts).toEqual([
      {
        type: 'recordings',
        root: '/data/rec',
        keptId: 'recordings:a',
        demotedIds: ['recordings:b'],
      },
    ])
  })

  it('a READ-ONLY duplicate is fine — only two WRITABLE aliases collide', () => {
    const draining: RecordingsLocation = recordingsLocationOfMode(
      { ...HIGH, id: 'recordings:old' },
      'readonly',
    )
    const result = demoteWritableAliasConflicts([HIGH, draining], identity)
    expect(result.conflicts).toEqual([])
    expect(result.locations.find((l) => l.id === 'recordings:default')?.readOnly).toBe(false)
  })

  it('collapses symlinked/bind-aliased roots through realpath, not string compare', () => {
    const linked: RecordingsLocation = { ...HIGH, id: 'recordings:link', root: '/mnt/link' }
    const realpath = (p: string): string => (p === '/mnt/link' ? '/data/rec' : p)
    const { conflicts } = demoteWritableAliasConflicts([HIGH, linked], realpath)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.demotedIds).toEqual(['recordings:link'])
  })

  it('distinct roots of the same type are NOT a conflict — that is the whole point of N locations', () => {
    const second: RecordingsLocation = { ...HIGH, id: 'recordings:ssd', root: '/mnt/ssd' }
    const result = demoteWritableAliasConflicts([HIGH, second], identity)
    expect(result.conflicts).toEqual([])
    expect(result.locations.every((l) => !l.readOnly)).toBe(true)
  })

  it('is a no-op on a single location — today’s live shape is byte-identical', () => {
    const result = demoteWritableAliasConflicts([HIGH], identity)
    expect(result.conflicts).toEqual([])
    expect(result.locations).toEqual([HIGH])
  })
})
