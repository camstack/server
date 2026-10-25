/**
 * evaluateZoneRules — shared rules-driven gate. Exercises every
 * branch of the canonical evaluator so motion-wasm + detection-
 * pipeline + any future consumer can rely on identical semantics.
 */
import { describe, it, expect } from 'vitest'
import type { Zone, ZoneRule } from '../../capabilities/index.js'
import { evaluateZoneRules } from '../zone-rule-eval.js'

const driveway: Zone = {
  id: 'drv',
  name: 'Driveway',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 0, y: 0.5 },
  ],
  color: '#3b82f6',
}
const porch: Zone = {
  ...driveway,
  id: 'porch',
  name: 'Porch',
  polygon: [
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 1, y: 1 },
    { x: 0.5, y: 1 },
  ],
}

interface Item {
  readonly id: string
  readonly cx: number
  readonly cy: number
  readonly className?: string
}
const at = (id: string, cx: number, cy: number, className?: string): Item => ({
  id,
  cx,
  cy,
  ...(className !== undefined ? { className } : {}),
})
const center = (item: Item) => ({ x: item.cx, y: item.cy })
const cls = (item: Item) => item.className

describe('evaluateZoneRules', () => {
  it('passes everything when rules empty', () => {
    const items = [at('a', 0.1, 0.1), at('b', 0.7, 0.7)]
    const res = evaluateZoneRules(items, [driveway, porch], [], center)
    expect(res.passed).toEqual(items)
    expect(res.excluded).toEqual([])
  })

  it('passes everything when zones empty', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['drv'], mode: 'exclude', enabled: true }
    const items = [at('a', 0.1, 0.1)]
    const res = evaluateZoneRules(items, [], [rule], center)
    expect(res.passed).toEqual(items)
  })

  it('exclude rule (blacklist mode) drops items inside the targeted zone', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['drv'], mode: 'exclude', enabled: true }
    const items = [at('inside', 0.1, 0.1), at('outside', 0.7, 0.7)]
    const res = evaluateZoneRules(items, [driveway, porch], [rule], center)
    expect(res.passed.map((i) => i.id)).toEqual(['outside'])
    expect(res.excluded.map((i) => i.id)).toEqual(['inside'])
  })

  it('include rule (whitelist mode) keeps only items inside the zone', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['porch'], mode: 'include', enabled: true }
    const items = [at('in-porch', 0.7, 0.7), at('in-drv', 0.1, 0.1), at('outside', 0.95, 0.05)]
    const res = evaluateZoneRules(items, [driveway, porch], [rule], center)
    expect(res.passed.map((i) => i.id)).toEqual(['in-porch'])
  })

  it('classFilter narrows include rule to specific classes', () => {
    const rule: ZoneRule = {
      id: 'r-1',
      zoneIds: ['porch'],
      mode: 'include',
      classFilter: ['person'],
      enabled: true,
    }
    const items = [
      at('p-in', 0.7, 0.7, 'person'),
      at('c-in', 0.7, 0.7, 'car'),
      at('p-out', 0.1, 0.1, 'person'),
    ]
    const res = evaluateZoneRules(items, [driveway, porch], [rule], center, cls)
    // include mode + classFilter: only person inside porch passes
    expect(res.passed.map((i) => i.id)).toEqual(['p-in'])
  })

  it('classFilter on exclude rule narrows to listed classes only', () => {
    const rule: ZoneRule = {
      id: 'r-1',
      zoneIds: ['drv'],
      mode: 'exclude',
      classFilter: ['person'],
      enabled: true,
    }
    const items = [
      at('p-in', 0.1, 0.1, 'person'),
      at('c-in', 0.1, 0.1, 'car'),
      at('p-out', 0.7, 0.7, 'person'),
    ]
    const res = evaluateZoneRules(items, [driveway, porch], [rule], center, cls)
    // exclude restricted to 'person' — car in driveway passes; person out passes
    expect(res.passed.map((i) => i.id).toSorted()).toEqual(['c-in', 'p-out'])
    expect(res.excluded.map((i) => i.id)).toEqual(['p-in'])
  })

  it('motion stage (no className accessor): classFilter rules still apply by zone match alone', () => {
    // When getClassName is omitted, rule.classFilter is treated as
    // matching every item — so a class-restricted exclude rule still
    // drops items in its zone. This is the documented motion-stage
    // semantics — motion has no class concept.
    const rule: ZoneRule = {
      id: 'r-1',
      zoneIds: ['drv'],
      mode: 'exclude',
      classFilter: ['person'],
      enabled: true,
    }
    const items = [at('inside', 0.1, 0.1), at('outside', 0.7, 0.7)]
    const res = evaluateZoneRules(items, [driveway, porch], [rule], center)
    expect(res.passed.map((i) => i.id)).toEqual(['outside'])
    expect(res.excluded.map((i) => i.id)).toEqual(['inside'])
  })

  it('disabled rules are skipped', () => {
    const rule: ZoneRule = { id: 'r-1', zoneIds: ['drv'], mode: 'exclude', enabled: false }
    const items = [at('inside', 0.1, 0.1), at('outside', 0.7, 0.7)]
    const res = evaluateZoneRules(items, [driveway, porch], [rule], center)
    expect(res.passed).toEqual(items)
  })

  it('multi-zone rule fires when center is in any of the targeted zones (OR)', () => {
    const rule: ZoneRule = {
      id: 'r-multi',
      zoneIds: ['drv', 'porch'],
      mode: 'exclude',
      enabled: true,
    }
    const items = [at('in-drv', 0.1, 0.1), at('in-porch', 0.7, 0.7), at('outside', 0.95, 0.05)]
    const res = evaluateZoneRules(items, [driveway, porch], [rule], center)
    expect(res.passed.map((i) => i.id)).toEqual(['outside'])
    expect(res.excluded.map((i) => i.id).toSorted()).toEqual(['in-drv', 'in-porch'])
  })
})
