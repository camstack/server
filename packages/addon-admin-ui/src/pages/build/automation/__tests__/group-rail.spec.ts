/**
 * The group rail colours: a nested block never takes its parent's colour, and
 * sibling blocks all differ until the palette runs out.
 */
import type { AutomationWhen } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { childRail, childRails, GROUP_RAIL_CLASSES, railClass, ROOT_RAIL } from '../group-rail'

const ROW: AutomationWhen = { kind: 'manual' }
const BLOCK: AutomationWhen = { kind: 'any', children: [ROW] }

describe('group rail', () => {
  it('gives a nested block a colour other than its parent, at any parent', () => {
    for (let parent = 0; parent < GROUP_RAIL_CLASSES.length; parent++) {
      for (let ordinal = 0; ordinal < 10; ordinal++) {
        expect(childRail(parent, ordinal)).not.toBe(parent)
      }
    }
  })

  it('gives sibling blocks distinct colours up to the palette size minus the parent', () => {
    const siblings = Array.from({ length: GROUP_RAIL_CLASSES.length - 1 }, (_, i) =>
      childRail(ROOT_RAIL, i),
    )
    expect(new Set(siblings).size).toBe(siblings.length)
  })

  it('counts only blocks and NOTs: a row sits on its parent rail', () => {
    const rails = childRails([ROW, BLOCK, ROW, { kind: 'not', child: BLOCK }], ROOT_RAIL)
    expect(rails[0]).toBeNull()
    expect(rails[2]).toBeNull()
    expect(rails[1]).toBe(childRail(ROOT_RAIL, 0))
    expect(rails[3]).toBe(childRail(ROOT_RAIL, 1))
    expect(rails[1]).not.toBe(rails[3])
  })

  it('maps every rail to a theme token class, never a palette class', () => {
    for (let rail = 0; rail < 8; rail++) {
      expect(railClass(rail)).toMatch(/^border-chart-series-[a-h]$/)
    }
  })
})
