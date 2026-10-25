import { describe, it, expect } from 'vitest'
import type { ChildLayout } from '@camstack/types'
import { groupChildrenByLayout } from '../child-layout'
import type { DeviceItemDevice } from '../helpers'

const PARENT_STABLE_ID = 'provider-test-container-1'

function child(suffix: string, name: string, id: number): DeviceItemDevice {
  return {
    id,
    stableId: `${PARENT_STABLE_ID}-${suffix}`,
    addonId: 'provider-test',
    type: 'numeric-sensor',
    name,
    online: true,
    disabled: false,
    parentDeviceId: 1,
    role: 'numeric-sensor',
    features: [],
  }
}

function disabledChild(suffix: string, name: string, id: number): DeviceItemDevice {
  return { ...child(suffix, name, id), disabled: true }
}

describe('groupChildrenByLayout', () => {
  it('returns all children ungrouped when childLayout is undefined', () => {
    const children = [child('a', 'A', 1), child('b', 'B', 2)]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, children, undefined)
    expect(result.sections).toEqual([])
    expect(result.ungrouped).toEqual(children)
  })

  it('returns all children ungrouped when childLayout is empty', () => {
    const children = [child('a', 'A', 1)]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, children, [])
    expect(result.sections).toEqual([])
    expect(result.ungrouped).toEqual(children)
  })

  it('matches a child when stableId === `${parentStableId}-${childKey}`', () => {
    const c = child('voltage', 'Voltage', 1)
    const layout: ChildLayout = [{ childKey: 'voltage', section: 'Diagnostics' }]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [c], layout)
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]?.title).toBe('Diagnostics')
    expect(result.sections[0]?.children).toEqual([c])
    expect(result.ungrouped).toEqual([])
  })

  it('leaves unmatched children ungrouped (rendered plainly)', () => {
    const matched = child('voltage', 'Voltage', 1)
    const unmatched = child('temp', 'Temperature', 2)
    const layout: ChildLayout = [{ childKey: 'voltage', section: 'Diagnostics' }]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [matched, unmatched], layout)
    expect(result.sections[0]?.children).toEqual([matched])
    expect(result.ungrouped).toEqual([unmatched])
  })

  it('ignores layout entries whose childKey has no matching child', () => {
    const c = child('voltage', 'Voltage', 1)
    const layout: ChildLayout = [
      { childKey: 'voltage', section: 'Diagnostics' },
      { childKey: 'does-not-exist', section: 'Phantom' },
    ]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [c], layout)
    // Phantom section is dropped — no matching child created it.
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]?.title).toBe('Diagnostics')
  })

  it('emits no section when all entries of that section have unmatched childKeys', () => {
    const layout: ChildLayout = [{ childKey: 'ghost', section: 'Phantom', collapsed: true }]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [], layout)
    expect(result.sections).toHaveLength(0)
  })

  it('orders children within a section by `order` then by name', () => {
    const a = child('a', 'Zebra', 1) // order 2
    const b = child('b', 'Apple', 2) // order 1
    const c = child('c', 'Mango', 3) // no order → MAX, sorts last
    const d = child('d', 'Berry', 4) // no order → MAX, then by name (Berry < Mango)
    const layout: ChildLayout = [
      { childKey: 'a', section: 'S', order: 2 },
      { childKey: 'b', section: 'S', order: 1 },
      { childKey: 'c', section: 'S' },
      { childKey: 'd', section: 'S' },
    ]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [a, b, c, d], layout)
    const names = result.sections[0]?.children.map((x) => x.name)
    expect(names).toEqual(['Apple', 'Zebra', 'Berry', 'Mango'])
  })

  it('orders sections by first appearance in childLayout', () => {
    const a = child('a', 'A', 1)
    const b = child('b', 'B', 2)
    const cc = child('c', 'C', 3)
    const layout: ChildLayout = [
      { childKey: 'c', section: 'Third' },
      { childKey: 'a', section: 'First' },
      { childKey: 'b', section: 'First' },
    ]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [a, b, cc], layout)
    expect(result.sections.map((s) => s.title)).toEqual(['Third', 'First'])
    expect(result.sections[1]?.children.map((x) => x.name)).toEqual(['A', 'B'])
  })

  it('defaults a section to open (defaultOpen=true) when no entry sets collapsed', () => {
    const c = child('voltage', 'Voltage', 1)
    const layout: ChildLayout = [{ childKey: 'voltage', section: 'Diagnostics' }]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [c], layout)
    expect(result.sections[0]?.defaultOpen).toBe(true)
  })

  it('marks a section collapsed (defaultOpen=false) when all entries set collapsed:true', () => {
    const v = child('voltage', 'Voltage', 1)
    const cur = child('current', 'Current', 2)
    const layout: ChildLayout = [
      { childKey: 'voltage', section: 'Disabled', collapsed: true },
      { childKey: 'current', section: 'Disabled', collapsed: true },
    ]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [v, cur], layout)
    expect(result.sections[0]?.title).toBe('Disabled')
    expect(result.sections[0]?.defaultOpen).toBe(false)
  })

  it('marks a section collapsed when ANY entry of the section sets collapsed:true', () => {
    const v = child('voltage', 'Voltage', 1)
    const cur = child('current', 'Current', 2)
    const layout: ChildLayout = [
      { childKey: 'voltage', section: 'Mixed' },
      { childKey: 'current', section: 'Mixed', collapsed: true },
    ]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [v, cur], layout)
    expect(result.sections[0]?.defaultOpen).toBe(false)
  })

  it('keeps other sections open while one section is collapsed', () => {
    const v = child('voltage', 'Voltage', 1)
    const t = child('temp', 'Temp', 2)
    const layout: ChildLayout = [
      { childKey: 'voltage', section: 'Disabled', collapsed: true },
      { childKey: 'temp', section: 'Sensors' },
    ]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [v, t], layout)
    const disabled = result.sections.find((s) => s.title === 'Disabled')
    const sensors = result.sections.find((s) => s.title === 'Sensors')
    expect(disabled?.defaultOpen).toBe(false)
    expect(sensors?.defaultOpen).toBe(true)
  })

  it('groups children across multiple sections and keeps the rest ungrouped', () => {
    const v = child('voltage', 'Voltage', 1)
    const cur = child('current', 'Current', 2)
    const plain = child('plain', 'Plain', 3)
    const layout: ChildLayout = [
      { childKey: 'voltage', section: 'Power' },
      { childKey: 'current', section: 'Power' },
    ]
    const result = groupChildrenByLayout(PARENT_STABLE_ID, [v, cur, plain], layout)
    expect(result.sections).toHaveLength(1)
    // No order on either → sort by name: Current before Voltage.
    expect(result.sections[0]?.children).toEqual([cur, v])
    expect(result.ungrouped).toEqual([plain])
  })

  describe('disabled children → trailing Disabled section', () => {
    it('places a disabled child in disabledSection (collapsed + muted), not sections/ungrouped', () => {
      const d = disabledChild('off', 'Off', 1)
      const result = groupChildrenByLayout(PARENT_STABLE_ID, [d], undefined)
      expect(result.disabledSection).toBeDefined()
      expect(result.disabledSection?.title).toBe('Disabled')
      expect(result.disabledSection?.defaultOpen).toBe(false)
      expect(result.disabledSection?.muted).toBe(true)
      expect(result.disabledSection?.children).toEqual([d])
      expect(result.sections).toEqual([])
      expect(result.ungrouped).toEqual([])
    })

    it('pulls a disabled child out of a provider section AND keeps it out of ungrouped', () => {
      const v = child('voltage', 'Voltage', 1)
      const offInSection = disabledChild('current', 'Current', 2)
      const offUngrouped = disabledChild('extra', 'Extra', 3)
      const layout: ChildLayout = [
        { childKey: 'voltage', section: 'Power' },
        { childKey: 'current', section: 'Power' },
      ]
      const result = groupChildrenByLayout(
        PARENT_STABLE_ID,
        [v, offInSection, offUngrouped],
        layout,
      )
      // The disabled child is gone from its provider section.
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0]?.children).toEqual([v])
      // And it never lands in ungrouped.
      expect(result.ungrouped).toEqual([])
      // Both disabled children land in the trailing section, sorted by name
      // (Current < Extra).
      expect(result.disabledSection?.children).toEqual([offInSection, offUngrouped])
    })

    it('omits disabledSection when no child is disabled', () => {
      const a = child('a', 'A', 1)
      const b = child('b', 'B', 2)
      const result = groupChildrenByLayout(PARENT_STABLE_ID, [a, b], undefined)
      expect(result.disabledSection).toBeUndefined()
    })

    it('mixed: enabled children group normally, only disabled go to Disabled', () => {
      const v = child('voltage', 'Voltage', 1)
      const cur = child('current', 'Current', 2)
      const plain = child('plain', 'Plain', 3)
      const off = disabledChild('off', 'Off', 4)
      const layout: ChildLayout = [{ childKey: 'voltage', section: 'Power' }]
      const result = groupChildrenByLayout(PARENT_STABLE_ID, [v, cur, plain, off], layout)
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0]?.children).toEqual([v])
      // Current + Plain (enabled, unmatched) stay ungrouped.
      expect(result.ungrouped).toEqual([cur, plain])
      expect(result.disabledSection?.children).toEqual([off])
    })

    it('sorts disabled children by name', () => {
      const z = disabledChild('z', 'Zebra', 1)
      const a = disabledChild('a', 'Apple', 2)
      const m = disabledChild('m', 'Mango', 3)
      const result = groupChildrenByLayout(PARENT_STABLE_ID, [z, a, m], undefined)
      expect(result.disabledSection?.children.map((c) => c.name)).toEqual([
        'Apple',
        'Mango',
        'Zebra',
      ])
    })
  })
})
