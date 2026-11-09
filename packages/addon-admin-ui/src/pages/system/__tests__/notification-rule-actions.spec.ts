/**
 * Authoring rules for a rule's actions: hooks name Action ids, buttons name one.
 */

import type { ActionEntry, NcRuleActions } from '@camstack/types'
import { NotificationActionIconSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  actionsToForm,
  EMPTY_RULE_ACTIONS,
  formActionSteps,
  formToActions,
  NC_ACTION_ICON_OPTIONS,
  validateRuleActions,
} from '../notification-rule-actions'

const KNOWN = new Set(['internal:a', 'internal:b'])

function entry(id: string, steps: ActionEntry['steps']): ActionEntry {
  return {
    id,
    name: id,
    addonId: 'system',
    source: 'internal',
    readOnly: false,
    steps,
    variables: [],
    status: { isRunning: false, lastRunAt: null, lastError: null },
  }
}

describe('an untouched rule round-trips', () => {
  it('emits undefined for an empty form, so the stored block is preserved', () => {
    expect(formToActions(EMPTY_RULE_ACTIONS)).toBeUndefined()
  })

  it('reads an absent actions block as empty rather than as a change', () => {
    expect(actionsToForm(undefined)).toEqual(EMPTY_RULE_ACTIONS)
  })

  it('carries every field of a stored block back out unchanged', () => {
    const stored: NcRuleActions = {
      onTrigger: ['internal:a', 'internal:b'],
      onTriggerOff: ['internal:b'],
      buttons: [{ id: 'open', label: 'Open', actionId: 'internal:a', icon: 'unlock' }],
    }
    expect(formToActions(actionsToForm(stored))).toEqual(stored)
  })

  it('drops a blank id and a half-filled button', () => {
    expect(
      formToActions({
        ...EMPTY_RULE_ACTIONS,
        onTrigger: ['', 'internal:a'],
        buttons: [{ id: 'x', label: '', actionId: 'internal:a' }],
      }),
    ).toEqual({ onTrigger: ['internal:a'] })
  })
})

describe('what is refused here', () => {
  it('flags a button naming an Action that does not exist', () => {
    const problems = validateRuleActions(
      { ...EMPTY_RULE_ACTIONS, buttons: [{ id: 'x', label: 'X', actionId: 'typo' }] },
      KNOWN,
    )
    expect(problems.map((p) => p.kind)).toContain('unknown-action')
  })

  it('flags a hook naming an Action that does not exist', () => {
    const problems = validateRuleActions({ ...EMPTY_RULE_ACTIONS, onTrigger: ['gone'] }, KNOWN)
    expect(problems.map((p) => p.kind)).toEqual(['unknown-action'])
  })

  it('flags more Actions than a hook may start', () => {
    const many = ['internal:a', 'internal:b', 'internal:a', 'internal:b', 'internal:a']
    const problems = validateRuleActions({ ...EMPTY_RULE_ACTIONS, onTrigger: many }, KNOWN)
    expect(problems.map((p) => p.kind)).toContain('too-many')
  })

  it('flags two buttons with one id', () => {
    const b = { id: 'x', label: 'X', actionId: 'internal:a' }
    const problems = validateRuleActions({ ...EMPTY_RULE_ACTIONS, buttons: [b, b] }, KNOWN)
    expect(problems.map((p) => p.kind)).toContain('duplicate-button')
  })

  it('accepts known Actions', () => {
    const problems = validateRuleActions(
      {
        ...EMPTY_RULE_ACTIONS,
        onTrigger: ['internal:a'],
        buttons: [{ id: 'x', label: 'X', actionId: 'internal:b' }],
      },
      KNOWN,
    )
    expect(problems).toEqual([])
  })
})

describe('formActionSteps', () => {
  it('collects the steps of every Action the form names, once', () => {
    const wait = { kind: 'wait', seconds: 1 } as const
    const out = formActionSteps(
      {
        ...EMPTY_RULE_ACTIONS,
        onTrigger: ['internal:a'],
        buttons: [{ id: 'x', label: 'X', actionId: 'internal:a' }],
      },
      [entry('internal:a', [wait]), entry('internal:b', [wait, wait])],
    )
    expect(out).toEqual([wait])
  })
})

describe('NC_ACTION_ICON_OPTIONS', () => {
  it('offers EVERY icon in the closed vocabulary', () => {
    const offered = new Set(NC_ACTION_ICON_OPTIONS.map((o) => o.value))
    const missing = NotificationActionIconSchema.options.filter((v) => !offered.has(v))
    expect(missing, 'icon tokens the operator cannot pick').toEqual([])
  })
})
