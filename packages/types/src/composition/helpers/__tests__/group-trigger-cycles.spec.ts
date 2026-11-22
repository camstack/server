import { describe, expect, it } from 'vitest'
import { composedDeviceStableId, type CompositionSourceRef } from '../../composition.js'
import { groupTriggerLoops, type TriggerGroup } from '../group-trigger-cycles.js'
import type { GroupTrigger } from '../group-triggers.js'

const ref = (stableId: string): CompositionSourceRef => ({ addonId: 'demo', stableId })
const asDevice = (blockId: string): CompositionSourceRef => ({
  addonId: 'composer',
  stableId: composedDeviceStableId(blockId),
})

function listensTo(id: string, device: CompositionSourceRef): GroupTrigger {
  return {
    id,
    source: { kind: 'becomes', device, cap: 'switch', fieldPath: 'on', becomes: true },
    action: { kind: 'switch' },
  }
}

function group(
  blockId: string,
  name: string,
  members: readonly CompositionSourceRef[],
  triggers: readonly GroupTrigger[],
): TriggerGroup {
  return {
    blockId,
    name,
    helper: {
      kind: 'group',
      templateId: 'light',
      aggregate: 'any',
      active: 'at-least-one',
      members: members.map((source) => ({ source, cap: 'switch', fieldPath: 'on' })),
      triggers: [...triggers],
    },
  }
}

const NAMES: Readonly<Record<string, string>> = {
  'lamp-1': 'Lamp 1',
  'lamp-7': 'Lamp 7',
  button: 'Button',
}
const nameOf = (r: CompositionSourceRef): string | null => NAMES[r.stableId] ?? null

describe('group trigger loops', () => {
  it('a button outside the group is no loop', () => {
    const a = group('a', 'Group A', [ref('lamp-1')], [listensTo('t1', ref('button'))])
    expect(groupTriggerLoops([a], 'a', nameOf)).toEqual([])
  })

  it('refuses a trigger on a member of its own group, by name', () => {
    const a = group('a', 'Group A', [ref('lamp-1')], [listensTo('t1', ref('lamp-1'))])
    expect(groupTriggerLoops([a], 'a', nameOf)).toEqual([
      {
        path: 'helper.triggers[0]',
        message:
          'trigger "t1" listens to "Lamp 1", which this group commands — it would fire itself',
      },
    ])
  })

  it('refuses a trigger on the group device itself', () => {
    const a = group('a', 'Group A', [ref('lamp-1')], [listensTo('t1', asDevice('a'))])
    expect(groupTriggerLoops([a], 'a', nameOf)).toHaveLength(1)
  })

  it('refuses a membership edit that makes a trigger source a member', () => {
    const before = group('a', 'Group A', [ref('lamp-1')], [listensTo('t1', ref('button'))])
    expect(groupTriggerLoops([before], 'a', nameOf)).toEqual([])
    const after = group(
      'a',
      'Group A',
      [ref('lamp-1'), ref('button')],
      [listensTo('t1', ref('button'))],
    )
    expect(groupTriggerLoops([after], 'a', nameOf)).toHaveLength(1)
  })

  it('names a cycle across two groups', () => {
    const a = group('a', 'Group A', [ref('lamp-1')], [listensTo('t2', ref('lamp-7'))])
    const b = group('b', 'Group B', [ref('lamp-7')], [listensTo('t1', ref('lamp-1'))])
    const loops = groupTriggerLoops([a, b], 'a', nameOf)
    expect(loops).toHaveLength(1)
    expect(loops[0]?.message).toBe(
      'cycle: Group A → Lamp 1 → (trigger t1) Group B → Lamp 7 → (trigger t2) Group A',
    )
  })

  it('follows a member that is itself a group, and ignores a disabled trigger', () => {
    const inner = group('in', 'Inner', [ref('lamp-1')], [])
    const outer = group('out', 'Outer', [asDevice('in')], [listensTo('t1', ref('lamp-1'))])
    expect(groupTriggerLoops([inner, outer], 'out', nameOf)).toHaveLength(1)
    const off = group(
      'out',
      'Outer',
      [asDevice('in')],
      [{ ...listensTo('t1', ref('lamp-1')), enabled: false }],
    )
    expect(groupTriggerLoops([inner, off], 'out', nameOf)).toEqual([])
  })

  it('a group with no trigger answers nothing', () => {
    expect(groupTriggerLoops([group('a', 'A', [ref('lamp-1')], [])], 'a', nameOf)).toEqual([])
  })
})
