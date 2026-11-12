/**
 * Event-leaf ids and the `triggered-by` state leaf (#499 phase 2): a tree with
 * several event leaves branches on WHICH one fired, in the tree itself and in
 * a step guard, by an id that survives reordering.
 */
import { describe, expect, it } from 'vitest'
import { ConditionMirror, evaluateWhenTree } from '../condition-eval.js'
import { validateRecipeBounds, type AutomationRecipe } from '../recipe.js'
import { ActionStepSchema } from '../recipe.js'
import { SchedulerStateTreeSchema } from '../scheduler.js'
import { evaluateStepCondition } from '../step-condition.js'
import {
  AutomationWhenSchema,
  eventLeafIdAt,
  validateWhenTree,
  type AutomationWhen,
} from '../when.js'

const mirror = new ConditionMirror([])
const motion = {
  kind: 'device-event',
  category: 'motion.on-motion-changed',
  id: 'motion',
} as const
const button = {
  kind: 'device-event',
  category: 'button.pressed',
  id: 'button',
} as const
const byMotion: AutomationWhen = { kind: 'triggered-by', leafIds: ['motion'] }
const either = {
  kind: 'any',
  children: [motion, button],
} as const satisfies AutomationWhen
const fetchers = {
  fetchSlice: async () => ({}),
  fetchStableIds: async () => new Map<string, number>(),
}
const SIREN: Extract<AutomationRecipe['actions'][number], { kind: 'command' }> = {
  kind: 'command',
  target: { kind: 'devices', ids: [616] },
  actionId: 'button.press',
}

describe('event-leaf ids', () => {
  it('every event leaf takes an optional id, and a malformed one is refused', () => {
    expect(AutomationWhenSchema.safeParse(motion).success).toBe(true)
    expect(AutomationWhenSchema.safeParse({ kind: 'manual', id: 'by-hand' }).success).toBe(true)
    expect(AutomationWhenSchema.safeParse({ ...motion, id: '' }).success).toBe(false)
    expect(AutomationWhenSchema.safeParse({ ...motion, id: 'has space' }).success).toBe(false)
  })

  it('reads the id of the leaf at a path, and null where there is none', () => {
    expect(eventLeafIdAt(either, 'when.1')).toBe('button')
    expect(eventLeafIdAt(either, 'when.7')).toBeNull()
    expect(eventLeafIdAt({ kind: 'manual' }, 'when')).toBeNull()
  })

  it('refuses two event leaves with the same id', () => {
    const twice = {
      kind: 'any',
      children: [motion, { ...button, id: 'motion' }],
    } as const
    expect(validateWhenTree(twice)).toContain('"motion"')
  })
})

describe('triggered-by', () => {
  it('needs at least one leaf id', () => {
    expect(AutomationWhenSchema.safeParse(byMotion).success).toBe(true)
    expect(AutomationWhenSchema.safeParse({ kind: 'triggered-by', leafIds: [] }).success).toBe(
      false,
    )
  })

  it('in the tree: true only for the run its leaf started, whatever the order of the rows', () => {
    const tree = {
      kind: 'all',
      children: [either, byMotion],
    } as const satisfies AutomationWhen
    expect(evaluateWhenTree(tree, mirror, 0, { firedPath: 'when.0.0' }).pass).toBe(true)
    const other = evaluateWhenTree(tree, mirror, 0, { firedPath: 'when.0.1' })
    expect(other.pass).toBe(false)
    expect(other.unknown).toBe(false)
    expect(other.nodes.find((n) => n.kind === 'triggered-by')?.reason).toContain('button')

    const reordered = {
      kind: 'all',
      children: [{ kind: 'any', children: [button, motion] }, byMotion],
    } as const satisfies AutomationWhen
    expect(evaluateWhenTree(reordered, mirror, 0, { firedPath: 'when.0.1' }).pass).toBe(true)
  })

  it('a run no event leaf started is false, not unknown', () => {
    const evaluation = evaluateWhenTree(byMotion, mirror, 0)
    expect(evaluation.pass).toBe(false)
    expect(evaluation.unknown).toBe(false)
  })

  it('in a step guard: reads the trigger the caller names, and is unknown when it names none', async () => {
    const now = (): number => 0
    const asked = async (trigger?: { leafId: string | null }) =>
      (await evaluateStepCondition(byMotion, fetchers, now, undefined, undefined, trigger)).result
    expect(await asked({ leafId: 'motion' })).toBe('true')
    expect(await asked({ leafId: 'button' })).toBe('false')
    expect(await asked({ leafId: null })).toBe('false')
    expect(await asked()).toBe('unknown')
  })

  it('refuses an id no event leaf of the automation carries, in the tree and in a guard', () => {
    const inTree = {
      kind: 'all',
      children: [either, { kind: 'triggered-by', leafIds: ['door'] }],
    }
    const dangling: AutomationRecipe = {
      when: AutomationWhenSchema.parse(inTree),
      actions: [SIREN],
    }
    expect(validateRecipeBounds(dangling)).toContain('"door"')
    // a guard is judged as a tree on its own by the editor: the ids it names live in ANOTHER tree
    expect(validateWhenTree(byMotion)).toBeNull()

    const recipe: AutomationRecipe = {
      when: either,
      actions: [{ ...SIREN, if: { kind: 'triggered-by', leafIds: ['door'] } }],
    }
    expect(validateRecipeBounds(recipe)).toContain('"door"')
    expect(
      validateRecipeBounds({
        when: either,
        actions: [{ ...SIREN, if: byMotion }],
      }),
    ).toBeNull()
  })

  it('is refused where there is no trigger to read: a standalone step list and a scheduler', () => {
    const inAction = ActionStepSchema.safeParse({ ...SIREN, if: byMotion })
    expect(inAction.success).toBe(false)
    expect(inAction.error?.issues[0]?.message).toContain('has no trigger')
    expect(ActionStepSchema.safeParse(SIREN).success).toBe(true)

    const inScheduler = SchedulerStateTreeSchema.safeParse(byMotion)
    expect(inScheduler.success).toBe(false)
    expect(inScheduler.error?.issues[0]?.message).toContain('has no trigger')
  })
})
