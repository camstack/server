/**
 * R8 (D690): faces, zones and labels edit as ONE include-or-exclude field, the
 * control the object classes already use — never both lists side by side, and
 * no "any of / all of".
 */
import { describe, expect, it } from 'vitest'
import { applyConditionScope, conditionScopeDraftOf } from '../rule-condition-scopes'
import { switchRuleScopeMode, setRuleScopeList } from '../rule-scope-model'

describe('zones', () => {
  it('opens an included zone list on "Only these", an excluded one on "All except these"', () => {
    expect(conditionScopeDraftOf('zones', { zones: { ids: ['z1'], match: 'any' } }).mode).toBe(
      'only',
    )
    expect(conditionScopeDraftOf('zones', { zonesExclude: ['z2'] }).mode).toBe('except')
    expect(conditionScopeDraftOf('zones', {}).mode).toBe('all')
  })

  it('writes the included zones with NO quantifier — any/all is gone', () => {
    const draft = setRuleScopeList(
      switchRuleScopeMode(conditionScopeDraftOf('zones', {}), 'only'),
      ['z1', 'z2'],
    )
    expect(applyConditionScope('zones', { classes: ['person'] }, draft)).toEqual({
      classes: ['person'],
      zones: { ids: ['z1', 'z2'] },
    })
  })

  it('drops a legacy "all of" quantifier on the next write', () => {
    const opened = conditionScopeDraftOf('zones', { zones: { ids: ['z1'], match: 'all' } })
    expect(applyConditionScope('zones', { zones: { ids: ['z1'], match: 'all' } }, opened)).toEqual({
      zones: { ids: ['z1'] },
    })
  })

  it('an excluded list replaces the included one, never beside it', () => {
    const draft = setRuleScopeList(
      switchRuleScopeMode(conditionScopeDraftOf('zones', { zones: { ids: ['z1'] } }), 'except'),
      ['z9'],
    )
    expect(applyConditionScope('zones', { zones: { ids: ['z1'] } }, draft)).toEqual({
      zonesExclude: ['z9'],
    })
  })

  it('"All" writes neither key', () => {
    const draft = switchRuleScopeMode(
      conditionScopeDraftOf('zones', { zones: { ids: ['z1'] } }),
      'all',
    )
    expect(applyConditionScope('zones', { zones: { ids: ['z1'] } }, draft)).toEqual({})
  })

  it('keeps a LEGACY rule carrying both lists until the operator removes them (D49)', () => {
    const stored = { zones: { ids: ['z1'] }, zonesExclude: ['z2'] }
    const opened = conditionScopeDraftOf('zones', stored)
    expect(opened.legacyBoth).toBe(true)
    expect(applyConditionScope('zones', stored, opened)).toEqual(stored)
  })
})

describe('identities (known faces)', () => {
  it('keeps "only known faces" — an EMPTY included list is a real choice', () => {
    const opened = conditionScopeDraftOf('identities', { identities: [] })
    expect(opened.mode).toBe('only')
    expect(applyConditionScope('identities', { identities: [] }, opened)).toEqual({
      identities: [],
    })
  })

  it('switching to "Only these" with nobody picked authors "any known face"', () => {
    const draft = switchRuleScopeMode(conditionScopeDraftOf('identities', {}), 'only')
    expect(applyConditionScope('identities', {}, draft)).toEqual({ identities: [] })
  })

  it('"All" means anybody, recognised or not — neither key', () => {
    const draft = switchRuleScopeMode(
      conditionScopeDraftOf('identities', { identities: ['id-1'] }),
      'all',
    )
    expect(applyConditionScope('identities', { identities: ['id-1'] }, draft)).toEqual({})
  })

  it('an exclusion is written alone', () => {
    const draft = setRuleScopeList(
      switchRuleScopeMode(conditionScopeDraftOf('identities', {}), 'except'),
      ['id-2'],
    )
    expect(applyConditionScope('identities', {}, draft)).toEqual({ identitiesExclude: ['id-2'] })
  })

  it('keeps a legacy exclusion beside "only known faces" rather than dropping it', () => {
    const stored = { identities: [], identitiesExclude: ['id-3'] }
    const opened = conditionScopeDraftOf('identities', stored)
    expect(opened.legacyBoth).toBe(true)
    expect(applyConditionScope('identities', stored, opened)).toEqual(stored)
  })
})

describe('labels', () => {
  it('edits labelEquals as an include-only list', () => {
    const opened = conditionScopeDraftOf('labels', { labelEquals: ['Alice'] })
    expect(opened.mode).toBe('only')
    const next = setRuleScopeList(opened, ['Alice', 'AB123CD'])
    expect(applyConditionScope('labels', { labelEquals: ['Alice'] }, next)).toEqual({
      labelEquals: ['Alice', 'AB123CD'],
    })
  })

  it('an emptied list removes the key', () => {
    const next = setRuleScopeList(conditionScopeDraftOf('labels', { labelEquals: ['x'] }), [])
    expect(applyConditionScope('labels', { labelEquals: ['x'] }, next)).toEqual({})
  })
})
