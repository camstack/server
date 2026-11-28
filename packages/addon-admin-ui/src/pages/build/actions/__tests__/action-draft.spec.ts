import type { ActionEntry } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  checkDraft,
  draftOf,
  newVariable,
  renameVariable,
  triggerAlarmDraft,
  variablesUsedBy,
} from '../action-draft'

const ENTRY: ActionEntry = {
  id: 'internal:feed-dog',
  name: 'Feed the dog',
  addonId: 'core-blocks',
  source: 'internal',
  readOnly: false,
  steps: [
    {
      kind: 'command',
      target: { kind: 'devices', ids: [201] },
      actionId: 'petFeeder.feed',
      args: { grams: { $var: 'grams' } },
    },
    { kind: 'wait', seconds: 5 },
  ],
  variables: [{ name: 'grams', label: 'Portion', type: 'number', default: 30 }],
  status: { isRunning: false, lastRunAt: null, lastError: null },
}

describe('action draft', () => {
  it('carries the tags from the entry through to the saved input (D1054)', () => {
    const draft = draftOf({ ...ENTRY, tags: ['Garden', 'pets'] })
    expect(draft.tags).toEqual(['Garden', 'pets'])
    const check = checkDraft(draft)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.input.tags).toEqual(['Garden', 'pets'])
  })

  it('saves an emptied tag list as [] so the server clears it', () => {
    const check = checkDraft({ ...draftOf({ ...ENTRY, tags: ['x'] }), tags: [] })
    expect(check.ok && check.input.tags).toEqual([])
  })

  it('prefills a trigger-the-alarm Action as one alarm.trigger command step', () => {
    const check = checkDraft(triggerAlarmDraft(1023, 'Trigger the alarm'))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.input.steps).toEqual([
      { kind: 'command', target: { kind: 'devices', ids: [1023] }, actionId: 'alarm.trigger' },
    ])
  })

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
          kind: 'command' as const,
          target: { kind: 'var' as const, name: 'siren' },
          actionId: 'switch.on',
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

describe('an action with every step kind', () => {
  const WIDE: ActionEntry = {
    id: 'internal:wide',
    name: 'Wide',
    addonId: 'core-blocks',
    source: 'internal',
    readOnly: false,
    status: { isRunning: false, lastRunAt: null, lastError: null },
    variables: [{ name: 'room', type: 'string' }],
    steps: [
      { kind: 'notify', targetId: 't1', body: 'door open in {{vars.room}}' },
      {
        kind: 'http-request',
        method: 'POST',
        url: 'http://ccu.local/{{vars.room}}',
        timeoutSeconds: 2,
        body: '{"place":"{{vars.room}}"}',
      },
      {
        kind: 'choose',
        branches: [
          {
            if: { kind: 'all', children: [] },
            steps: [
              {
                kind: 'command',
                target: { kind: 'var', name: 'room' },
                actionId: 'switch.on',
              },
            ],
          },
        ],
      },
    ],
  }

  it('finds the variables read by nested steps, in a notify text it does not (a set may have written it)', () => {
    expect(variablesUsedBy(draftOf(WIDE).steps)).toEqual(['room'])
  })

  it('renames a variable inside notify, http, nested commands and texts', () => {
    const renamed = renameVariable(draftOf(WIDE), 0, 'zone')
    expect(JSON.stringify(renamed.steps)).not.toContain('room')
    expect(JSON.stringify(renamed.steps)).toContain('{{vars.zone}}')
    expect(variablesUsedBy(renamed.steps)).toEqual(['zone'])
    expect(checkDraft(renamed).ok).toBe(true)
  })
})
