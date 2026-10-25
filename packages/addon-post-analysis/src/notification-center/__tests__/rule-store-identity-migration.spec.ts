/**
 * NAME → ID, resolved on READ.
 *
 * Rules authored before identities were matched by id hold display names. They
 * are resolved against the live gallery every time the rule set loads, exactly
 * as the scope v2→v3 migration is: a projection, never a write-back. The
 * direction of every ambiguity is "leave the operator's rule alone", because
 * the alternative — a gallery read that failed rewriting a rule into one that
 * matches nobody — is the silent failure this whole area keeps producing.
 */

import type { NcRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { migrateIdentityNames } from '../rule-store.js'

function rule(conditions: Record<string, unknown>): NcRule {
  return {
    id: 'r1',
    name: 'known faces',
    enabled: true,
    delivery: 'immediate',
    conditions,
    targets: [{ targetId: 't' }],
    media: { attach: 'best' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    disabledTargetIds: [],
    createdBy: 'admin',
    createdAt: 0,
    updatedAt: 0,
  } as NcRule
}

const GALLERY = new Map([
  ['alice', 'id-alice'],
  ['van', 'veh-van'],
])

describe('migrateIdentityNames', () => {
  it('resolves a display name to its gallery id', () => {
    const result = migrateIdentityNames(rule({ identities: ['Alice'] }), GALLERY)
    expect(result.rule.conditions.identities).toEqual(['id-alice'])
    expect(result.unresolved).toEqual([])
  })

  it('is case- and whitespace-insensitive, like every other name comparison here', () => {
    const result = migrateIdentityNames(rule({ identities: ['  aLiCe '] }), GALLERY)
    expect(result.rule.conditions.identities).toEqual(['id-alice'])
  })

  it('is idempotent — a second load leaves an already-migrated rule alone', () => {
    const once = migrateIdentityNames(rule({ identities: ['Alice'] }), GALLERY)
    const twice = migrateIdentityNames(once.rule, GALLERY)
    expect(twice.rule).toBe(once.rule)
    expect(twice.unresolved).toEqual([])
  })

  // The load-bearing half. A name nothing answers for is KEPT and reported —
  // dropping it would shrink the rule's scope silently, and the engine's name
  // leg keeps it matching whatever it matched yesterday.
  it('KEEPS an unresolvable name and reports it', () => {
    const result = migrateIdentityNames(rule({ identities: ['Alice', 'Ghost'] }), GALLERY)
    expect(result.rule.conditions.identities).toEqual(['id-alice', 'Ghost'])
    expect(result.unresolved).toEqual(['Ghost'])
  })

  // NEUTRALISATION: with an EMPTY gallery — a failed read, a cold store —
  // nothing may change. If this returned ids, the migration would be inventing
  // them; if it dropped names, a read failure would disarm live rules.
  it('an EMPTY gallery migrates nothing and rewrites nothing', () => {
    const original = rule({ identities: ['Alice'], identitiesExclude: ['Van'] })
    const result = migrateIdentityNames(original, new Map())
    expect(result.rule).toBe(original)
    expect(result.unresolved).toEqual(['Alice', 'Van'])
  })

  it('migrates the exclude list too', () => {
    const result = migrateIdentityNames(rule({ identitiesExclude: ['Van'] }), GALLERY)
    expect(result.rule.conditions.identitiesExclude).toEqual(['veh-van'])
  })

  it('leaves a rule with no identity condition untouched, by identity', () => {
    const original = rule({ classes: ['person'] })
    expect(migrateIdentityNames(original, GALLERY).rule).toBe(original)
  })

  // The empty list is the "only known faces" state and must survive a load.
  it('preserves the EMPTY list', () => {
    const result = migrateIdentityNames(rule({ identities: [] }), GALLERY)
    expect(result.rule.conditions.identities).toEqual([])
  })
})
