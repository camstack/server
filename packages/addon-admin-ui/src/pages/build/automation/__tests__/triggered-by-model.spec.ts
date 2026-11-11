/**
 * The `triggered-by` row's model: trigger rows get an id only once a row
 * refers to triggers, the ids never collide with ones already there, and the
 * row's choices are the automation's own trigger rows.
 */
import type { AutomationRecipe, TriggeredByLeaf } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ensureTriggerIds, toggleTrigger, triggerRowsOf } from '../triggered-by-model'

const MOTION = { kind: 'device-event', category: 'motion.on-motion-changed' } as const
const PRESS = { kind: 'device-event', category: 'button.pressed', deviceId: 7 } as const
const SIREN = { kind: 'cap', deviceId: 616, cap: 'siren', method: 'on' } as const
const ASK: TriggeredByLeaf = { kind: 'triggered-by', leafIds: [] }

describe('ensureTriggerIds', () => {
  it('leaves a recipe with no triggered-by row untouched, by identity', () => {
    const recipe: AutomationRecipe = {
      when: { kind: 'any', children: [MOTION, PRESS] },
      actions: [SIREN],
    }
    expect(ensureTriggerIds(recipe)).toBe(recipe)
  })

  it('names every trigger row once a step guard asks which one fired, keeping ids already there', () => {
    const recipe: AutomationRecipe = {
      when: { kind: 'any', children: [{ ...MOTION, id: 't1' }, PRESS, { kind: 'manual' }] },
      actions: [{ ...SIREN, if: ASK }],
    }
    const named = ensureTriggerIds(recipe)
    expect(triggerRowsOf(named.when).map((row) => row.id)).toEqual(['t1', 't2', 't3'])
    expect(ensureTriggerIds(named)).toBe(named)
  })

  it('names them when the question sits in a stop condition, a branch of a choose or a wait (#500)', () => {
    const when: AutomationRecipe['when'] = { kind: 'any', children: [MOTION, PRESS] }
    const askers: AutomationRecipe['actions'] = [
      { kind: 'stop', reason: 'no', outcome: 'ok', if: ASK },
      { kind: 'choose', branches: [{ if: ASK, steps: [{ kind: 'wait', seconds: 1 }] }] },
      { kind: 'wait-until', when: ASK, timeoutS: 60, onTimeout: 'continue' },
    ]
    for (const step of askers) {
      const named = ensureTriggerIds({ when, actions: [step] })
      expect(triggerRowsOf(named.when).map((row) => row.id)).toEqual(['t1', 't2'])
    }
  })

  it('does the same for a triggered-by row inside the rules', () => {
    const recipe: AutomationRecipe = {
      when: { kind: 'all', children: [{ kind: 'any', children: [MOTION, PRESS] }, ASK] },
      actions: [SIREN],
    }
    expect(triggerRowsOf(ensureTriggerIds(recipe).when).map((row) => row.id)).toEqual(['t1', 't2'])
  })
})

describe('triggerRowsOf', () => {
  it('lists the named trigger rows in order, numbered among ALL trigger rows', () => {
    const rows = triggerRowsOf({
      kind: 'any',
      children: [MOTION, { ...PRESS, id: 'press' }],
    })
    expect(rows).toEqual([{ id: 'press', ordinal: 2, leaf: { ...PRESS, id: 'press' } }])
  })
})

describe('toggleTrigger', () => {
  it('adds and removes one id, in the order the rows are listed', () => {
    const one = toggleTrigger(ASK, 't2', ['t1', 't2'])
    expect(one.leafIds).toEqual(['t2'])
    expect(toggleTrigger(one, 't1', ['t1', 't2']).leafIds).toEqual(['t1', 't2'])
    expect(toggleTrigger(one, 't2', ['t1', 't2']).leafIds).toEqual([])
  })

  it('drops an id no row carries any more when the selection changes', () => {
    const stale: TriggeredByLeaf = { kind: 'triggered-by', leafIds: ['gone', 't1'] }
    expect(toggleTrigger(stale, 't2', ['t1', 't2']).leafIds).toEqual(['t1', 't2'])
  })
})
