import type { ActionEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { checkDraft, draftOf, newVariable, renameVariable, variablesUsedBy } from '../action-draft'

const ENTRY: ActionEntry = {
  id: 'internal:feed-dog',
  name: 'Feed the dog',
  addonId: 'core-blocks',
  source: 'internal',
  readOnly: false,
  steps: [
    {
      kind: 'cap',
      deviceId: 201,
      cap: 'pet-feeder',
      method: 'feed',
      args: { grams: { $var: 'grams' } },
    },
    { kind: 'wait', seconds: 5 },
  ],
  variables: [{ name: 'grams', label: 'Portion', type: 'number', default: 30 }],
  status: { isRunning: false, lastRunAt: null, lastError: null },
}

describe('action draft', () => {
  it('round-trips an entry through the draft to the input the hub accepts', () => {
    const check = checkDraft(draftOf(ENTRY))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.input).toEqual({
      name: 'Feed the dog',
      steps: ENTRY.steps,
      variables: ENTRY.variables,
    })
  })

  it('refuses a draft with no name, no steps, or a variable nothing declares', () => {
    const draft = draftOf(ENTRY)
    expect(checkDraft({ ...draft, name: '  ' })).toEqual({ ok: false, reason: { kind: 'name' } })
    expect(checkDraft({ ...draft, steps: [] })).toEqual({
      ok: false,
      reason: { kind: 'no-steps' },
    })
    expect(checkDraft({ ...draft, variables: [] })).toEqual({
      ok: false,
      reason: { kind: 'undeclared', name: 'grams' },
    })
  })

  it('refuses a variable declared twice or named in a way the schema rejects', () => {
    const draft = draftOf(ENTRY)
    const dup = {
      ...draft,
      variables: [...draft.variables, { name: 'grams', type: 'string' as const }],
    }
    expect(checkDraft(dup)).toEqual({ ok: false, reason: { kind: 'duplicate', name: 'grams' } })
    const bad = { ...draft, variables: [{ name: '1 gram', type: 'string' as const }] }
    expect(checkDraft(bad)).toEqual({ ok: false, reason: { kind: 'bad-name', name: '1 gram' } })
  })

  it('renaming a variable rewrites every reference, so no step is left with a hole', () => {
    const renamed = renameVariable(draftOf(ENTRY), 0, 'portion')
    expect(renamed.variables[0]?.name).toBe('portion')
    expect(variablesUsedBy(renamed.steps)).toEqual(['portion'])
    expect(checkDraft(renamed).ok).toBe(true)
  })

  it('renames a variable used as the step target too', () => {
    const draft = {
      name: 'Sound it',
      steps: [
        {
          kind: 'cap' as const,
          deviceId: { $var: 'siren' },
          cap: 'siren',
          method: 'turnOn',
        },
      ],
      variables: [{ name: 'siren', type: 'number' as const }],
    }
    expect(variablesUsedBy(renameVariable(draft, 0, 'alarm').steps)).toEqual(['alarm'])
  })

  it('names a new variable with the first free name', () => {
    expect(newVariable([]).name).toBe('value')
    expect(newVariable([{ name: 'value', type: 'string' }]).name).toBe('value2')
  })
})
