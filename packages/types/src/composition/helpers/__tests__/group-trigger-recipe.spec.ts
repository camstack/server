import { describe, expect, it } from 'vitest'
import { evaluateWhenTree } from '../../../automation/condition-eval.js'
import { CurrentAutomationRecipeSchema } from '../../../automation/recipe.js'
import { EventCategory } from '../../../enums/event-category.js'
import { composedDeviceStableId, type CompositionSourceRef } from '../../composition.js'
import { evaluateAggregate } from '../aggregate.js'
import { groupTriggerRecipe } from '../group-trigger-recipe.js'
import type { GroupTrigger } from '../group-triggers.js'
import type { GroupHelperSpec } from '../spec.js'

const ref = (stableId: string, addonId = 'demo'): CompositionSourceRef => ({ addonId, stableId })
const IDS: Readonly<Record<string, number>> = {
  button: 10,
  cam: 11,
  'lamp-1': 21,
  'lamp-2': 22,
  'lamp-3': 23,
  [composedDeviceStableId('grp')]: 99,
}
const resolve = (r: CompositionSourceRef): number | null => IDS[r.stableId] ?? null

const press: GroupTrigger = {
  id: 't-press',
  source: { kind: 'fired', device: ref('button'), eventIds: ['PRESS_SHORT'], sourceIds: ['1'] },
  action: { kind: 'switch' },
}

function helper(
  over: Partial<GroupHelperSpec>,
  triggers: readonly GroupTrigger[] = [press],
): GroupHelperSpec {
  return {
    kind: 'group',
    templateId: 'light',
    aggregate: 'any',
    active: 'at-least-one',
    members: ['lamp-1', 'lamp-2'].map((id) => ({
      source: ref(id),
      cap: 'switch',
      fieldPath: 'on',
    })),
    triggers: [...triggers],
    ...over,
  }
}

function build(spec: GroupHelperSpec) {
  return groupTriggerRecipe({ blockId: 'grp', helper: spec, resolve })
}

describe('group trigger recipe', () => {
  it('writes one automation the group owns, valid against the recipe schema', () => {
    const { recipe, leftOut } = build(helper({}))
    expect(leftOut).toEqual([])
    expect(recipe).not.toBeNull()
    expect(CurrentAutomationRecipeSchema.safeParse(recipe).success).toBe(true)
    expect(recipe?.ownedBy).toEqual({ kind: 'group', blockId: 'grp' })
    expect(recipe?.runMode).toEqual({ mode: 'queued', max: 5 })
    expect(recipe?.when).toEqual({
      kind: 'any',
      children: [
        {
          kind: 'device-fired',
          id: 't-press',
          deviceId: 10,
          eventIds: ['PRESS_SHORT'],
          sourceIds: ['1'],
        },
      ],
    })
  })

  it('is stable: the same spec writes the same recipe', () => {
    expect(JSON.stringify(build(helper({})))).toBe(JSON.stringify(build(helper({}))))
  })

  it('device output: commands the group device, toggle included', () => {
    const triggers: GroupTrigger[] = [
      press,
      { ...press, id: 't-on', action: { kind: 'on' } },
      { ...press, id: 't-off', action: { kind: 'off' } },
    ]
    const { recipe } = build(helper({}, triggers))
    const commands = JSON.stringify(recipe?.actions)
    expect(commands).toContain('"switch.toggle"')
    expect(commands).toContain('"switch.on"')
    expect(commands).toContain('"switch.off"')
    expect(commands).toContain('"ids":[99]')
    expect(commands).not.toContain('21')
  })

  it('every trigger gets its own choose, guarded by its leaf id', () => {
    const { recipe } = build(helper({}, [press, { ...press, id: 't-b', action: { kind: 'on' } }]))
    expect(recipe?.actions).toHaveLength(2)
    expect(JSON.stringify(recipe?.actions[1])).toContain('"leafIds":["t-b"]')
  })

  it('maps the other sources to their leaves', () => {
    const triggers: GroupTrigger[] = [
      {
        id: 'ev',
        source: { kind: 'event', category: EventCategory.DoorbellOnPressed, device: ref('button') },
        action: { kind: 'on' },
      },
      {
        id: 'det',
        source: {
          kind: 'detection',
          devices: [ref('cam'), ref('ghost')],
          subjects: [{ macro: 'person' }],
        },
        action: { kind: 'on' },
      },
      {
        id: 'bec',
        source: {
          kind: 'becomes',
          device: ref('button'),
          cap: 'switch',
          fieldPath: 'on',
          becomes: true,
        },
        action: { kind: 'off' },
      },
    ]
    const { recipe } = build(helper({}, triggers))
    const leaves = recipe?.when.kind === 'any' ? recipe.when.children : []
    expect(leaves.map((leaf) => leaf.kind)).toEqual(['device-event', 'detection', 'device-becomes'])
    expect(leaves[1]).toMatchObject({ deviceIds: [11] })
  })

  it('leaves out a trigger whose device cannot be resolved, and says which', () => {
    const lost: GroupTrigger = {
      ...press,
      id: 't-lost',
      source: { kind: 'fired', device: ref('ghost') },
    }
    const { recipe, leftOut } = build(helper({}, [press, lost]))
    expect(leftOut).toEqual([{ triggerId: 't-lost', reason: expect.stringContaining('ghost') }])
    expect(recipe?.actions).toHaveLength(1)
  })

  it('no recipe when nothing is enabled or resolvable', () => {
    expect(build(helper({}, [{ ...press, enabled: false }])).recipe).toBeNull()
    expect(build(helper({}, [])).recipe).toBeNull()
  })

  it('climate: sets the mode and the target on the group', () => {
    const climate: GroupTrigger = {
      ...press,
      action: { kind: 'climate', mode: 'heat', target: 21 },
    }
    const { recipe } = build(helper({ templateId: 'climate' }, [climate]))
    const text = JSON.stringify(recipe?.actions)
    expect(text).toContain('"climate.mode"')
    expect(text).toContain('"climate.target"')
    expect(CurrentAutomationRecipeSchema.safeParse(recipe).success).toBe(true)
  })
})

describe('group trigger recipe, output none', () => {
  const none = (
    over: Partial<GroupHelperSpec> = {},
    triggers: readonly GroupTrigger[] = [press],
  ): GroupHelperSpec => helper({ output: 'none', ...over }, triggers)

  it('commands the members, never the group device', () => {
    const { recipe } = build(none({}, [{ ...press, action: { kind: 'on' } }]))
    const text = JSON.stringify(recipe?.actions)
    expect(text).toContain('"ids":[21,22]')
    expect(text).not.toContain('99')
    expect(CurrentAutomationRecipeSchema.safeParse(recipe).success).toBe(true)
  })

  it('a member that cannot be resolved is left out of the fan-out', () => {
    const members = ['lamp-1', 'ghost'].map((id) => ({
      source: ref(id),
      cap: 'switch',
      fieldPath: 'on',
    }))
    const { recipe } = build(none({ members }))
    expect(JSON.stringify(recipe?.actions)).toContain('21')
    expect(JSON.stringify(recipe?.actions)).not.toContain('22')
  })

  it('no member resolved: no recipe, every trigger left out', () => {
    const members = [{ source: ref('ghost'), cap: 'switch', fieldPath: 'on' }]
    const { recipe, leftOut } = build(none({ members }))
    expect(recipe).toBeNull()
    expect(leftOut.map((l) => l.triggerId)).toEqual(['t-press'])
  })

  const members = ['lamp-1', 'lamp-2', 'lamp-3']
  const states: ReadonlyArray<readonly (boolean | undefined)[]> = [
    [true, true, true],
    [true, false, false],
    [false, false, false],
    [false, true, undefined],
    [undefined, undefined, undefined],
    [true, undefined, undefined],
  ]

  for (const active of ['at-least-one', 'all'] as const) {
    it(`toggle decides like the group aggregate (${active})`, () => {
      const spec = none({
        active,
        aggregate: active === 'all' ? 'all' : 'any',
        members: members.map((id) => ({ source: ref(id), cap: 'switch', fieldPath: 'on' })),
      })
      const { recipe } = build(spec)
      const choose = recipe?.actions[0]
      if (choose?.kind !== 'choose') throw new Error('expected a choose')
      const inner = choose.branches[0]?.steps[0]
      if (inner?.kind !== 'choose') throw new Error('expected the toggle choose')
      for (const row of states) {
        const reader = {
          read: (deviceId: number) => row[deviceId - 21],
          readStable: () => undefined,
        }
        const verdicts = inner.branches.map((branch) => evaluateWhenTree(branch.if, reader, 0))
        const known = row.filter((v): v is boolean => v !== undefined)
        // A step condition cannot leave an unread member out (D49): nothing may run on no state.
        if (known.length === 0) {
          expect(verdicts.every((v) => !v.pass)).toBe(true)
          continue
        }
        // A partly unread row is judged as unknown by the step runner and runs nothing.
        if (known.length < row.length) continue
        const agg = evaluateAggregate({
          reducer: active === 'all' ? 'all' : 'any',
          members: row.map((value) => ({ state: 'fresh' as const, value })),
          publish: 'value',
          empty: 'null',
        })
        const value = agg.kind === 'value' ? agg.value : null
        const goesOff = verdicts[0]?.pass === true
        const goesOn = verdicts[0]?.pass !== true && verdicts[1]?.pass === true
        expect({ goesOff, goesOn }).toEqual({ goesOff: value === true, goesOn: value === false })
      }
    })
  }

  it('the toggle branches send off then on', () => {
    const { recipe } = build(none())
    const text = JSON.stringify(recipe?.actions)
    expect(text.indexOf('switch.off')).toBeLessThan(text.indexOf('switch.on'))
    expect(text).not.toContain('switch.toggle')
  })
})
