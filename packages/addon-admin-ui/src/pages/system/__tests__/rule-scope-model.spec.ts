/**
 * The scope pre-selector's model (D641): "All | Only these | All except
 * these" over ONE list per axis. Byte-identical with the viewer's copy of this
 * spec (`scripts/check-device-selection-in-sync.ts`).
 */
import { describe, expect, it } from 'vitest'
import {
  projectRuleScope,
  RULE_SCOPE_MODES,
  removeRuleScopeExclusions,
  ruleScopeClearedOnSave,
  ruleScopeDraftOf,
  ruleScopeLegacyExclusions,
  ruleScopeList,
  ruleScopeModeOf,
  setRuleScopeList,
  switchRuleScopeMode,
} from '../rule-scope-model'

describe('the mode is DERIVED from the stored lists', () => {
  it('include → Only, exclude → Except, neither → All', () => {
    expect(ruleScopeModeOf([101], undefined)).toBe('only')
    expect(ruleScopeModeOf(undefined, [104])).toBe('except')
    expect(ruleScopeModeOf(undefined, undefined)).toBe('all')
    expect(ruleScopeModeOf<string>([], [])).toBe('all')
  })

  it('both (legacy) → Only, the narrower reading', () => {
    expect(ruleScopeModeOf([101], [104])).toBe('only')
  })

  it('the control draws the three modes in one order', () => {
    expect(RULE_SCOPE_MODES).toEqual(['all', 'only', 'except'])
  })
})

describe('switching the mode moves nothing', () => {
  it('the list you leave is kept, and switching back restores it', () => {
    const opened = ruleScopeDraftOf([101, 102], undefined)
    const except = switchRuleScopeMode(opened, 'except')
    expect(ruleScopeList(except)).toEqual([])
    const edited = setRuleScopeList(except, [104])
    const back = switchRuleScopeMode(edited, 'only')
    expect(ruleScopeList(back)).toEqual([101, 102])
    expect(ruleScopeList(switchRuleScopeMode(back, 'except'))).toEqual([104])
  })

  it('All edits no list', () => {
    const all = switchRuleScopeMode(ruleScopeDraftOf([101], undefined), 'all')
    expect(ruleScopeList(all)).toEqual([])
    expect(setRuleScopeList(all, [1])).toBe(all)
  })
})

describe('a save writes ONLY the active mode', () => {
  it('Only writes the include list and clears the exclusion left behind', () => {
    const draft = setRuleScopeList(
      switchRuleScopeMode(ruleScopeDraftOf(undefined, [104]), 'only'),
      [101],
    )
    expect(projectRuleScope(draft)).toEqual({ include: [101] })
    expect(ruleScopeClearedOnSave(draft)).toEqual([104])
  })

  it('Except writes the exclude list and clears the include left behind', () => {
    const draft = setRuleScopeList(
      switchRuleScopeMode(ruleScopeDraftOf([101], undefined), 'except'),
      [104],
    )
    expect(projectRuleScope(draft)).toEqual({ exclude: [104] })
    expect(ruleScopeClearedOnSave(draft)).toEqual([101])
  })

  it('All clears both', () => {
    const draft = switchRuleScopeMode(ruleScopeDraftOf(['person'], ['cat']), 'all')
    expect(projectRuleScope(draft)).toEqual({})
    expect(ruleScopeClearedOnSave(draft)).toEqual(['person', 'cat'])
  })

  it('an empty list in its own mode writes nothing — the rule is unrestricted', () => {
    expect(projectRuleScope(switchRuleScopeMode(ruleScopeDraftOf([], []), 'only'))).toEqual({})
    expect(projectRuleScope(switchRuleScopeMode(ruleScopeDraftOf([], []), 'except'))).toEqual({})
  })

  it('an untouched rule round-trips exactly', () => {
    expect(projectRuleScope(ruleScopeDraftOf([101], undefined))).toEqual({ include: [101] })
    expect(projectRuleScope(ruleScopeDraftOf(undefined, ['cat']))).toEqual({ exclude: ['cat'] })
    expect(projectRuleScope(ruleScopeDraftOf(undefined, undefined))).toEqual({})
    expect(ruleScopeClearedOnSave(ruleScopeDraftOf([101], undefined))).toEqual([])
  })
})

describe('the legacy rule carrying BOTH (D49: nothing silently dropped)', () => {
  const legacy = ruleScopeDraftOf([101], [104])

  it('opens in Only, and its exclusions are listed for the notice', () => {
    expect(legacy.mode).toBe('only')
    expect(legacy.legacyBoth).toBe(true)
    expect(ruleScopeLegacyExclusions(legacy)).toEqual([104])
  })

  it('a save keeps BOTH lists until the operator removes the exclusions', () => {
    expect(projectRuleScope(legacy)).toEqual({ include: [101], exclude: [104] })
    expect(ruleScopeClearedOnSave(legacy)).toEqual([])
    const edited = setRuleScopeList(legacy, [101, 102])
    expect(projectRuleScope(edited)).toEqual({ include: [101, 102], exclude: [104] })
  })

  it('"Remove exclusions" is the only way they go', () => {
    const removed = removeRuleScopeExclusions(legacy)
    expect(ruleScopeLegacyExclusions(removed)).toEqual([])
    expect(projectRuleScope(removed)).toEqual({ include: [101] })
  })

  it('switching to Except shows the exclusions as the list, and drops the include on save', () => {
    const except = switchRuleScopeMode(legacy, 'except')
    expect(ruleScopeList(except)).toEqual([104])
    expect(ruleScopeLegacyExclusions(except)).toEqual([])
    expect(projectRuleScope(except)).toEqual({ exclude: [104] })
    expect(ruleScopeClearedOnSave(except)).toEqual([101])
  })

  it('a rule that is not legacy never carries its left-behind exclusion into Only', () => {
    const switched = switchRuleScopeMode(
      setRuleScopeList(switchRuleScopeMode(ruleScopeDraftOf([101], undefined), 'except'), [104]),
      'only',
    )
    expect(ruleScopeLegacyExclusions(switched)).toEqual([])
    expect(projectRuleScope(switched)).toEqual({ include: [101] })
  })
})
