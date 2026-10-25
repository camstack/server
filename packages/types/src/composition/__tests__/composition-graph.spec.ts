import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { type Composition, CompositionSchema, composedDeviceRef } from '../composition.js'
import {
  CompositionGraphError,
  compositionEdges,
  findCandidateCycles,
  findCompositionCycles,
} from '../composition-graph.js'

const SENSOR = { addonId: 'provider-homeassistant', stableId: 'sensor.hall' }

function numeric(fields: Readonly<Record<string, unknown>>, enabled?: boolean): Composition {
  return CompositionSchema.parse({
    target: { kind: 'new', type: DeviceType.Sensor },
    features: [{ kind: 'fields', cap: 'numeric-sensor', fields, enabled }],
  })
}

type Ref = { addonId: string; stableId: string }

const read = (source: Ref, fieldPath: string) => ({
  kind: 'from',
  source,
  cap: 'numeric-sensor',
  fieldPath,
})

const expression = (bindings: Readonly<Record<string, unknown>>, expr: string) => ({
  kind: 'expression',
  expr,
  bindings,
})

/** The exact node key `findCompositionCycles` reports, so path assertions never hand-typed. */
const key = (source: Ref, fieldPath: string) =>
  `${source.addonId}/${source.stableId}#numeric-sensor.${fieldPath}`

describe('findCompositionCycles', () => {
  it('finds a field that reads itself, naming the path', () => {
    const self = composedDeviceRef('a')
    const cycles = findCompositionCycles(
      { blockId: 'a', target: self, composition: numeric({ value: read(self, 'value') }) },
      [],
    )
    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.path).toEqual([key(self, 'value'), key(self, 'value')])
  })

  it('finds a cycle THROUGH another composition, naming every hop in order', () => {
    const a = composedDeviceRef('a')
    const b = composedDeviceRef('b')
    const cycles = findCompositionCycles(
      { blockId: 'a', target: a, composition: numeric({ value: read(b, 'value') }) },
      [{ blockId: 'b', target: b, composition: numeric({ value: read(a, 'value') }) }],
    )
    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.path).toEqual([key(b, 'value'), key(a, 'value'), key(b, 'value')])
  })

  it('accepts a chain (b reads a, a reads a sensor)', () => {
    const a = composedDeviceRef('a')
    const b = composedDeviceRef('b')
    expect(
      findCompositionCycles(
        { blockId: 'b', target: b, composition: numeric({ value: read(a, 'value') }) },
        [{ blockId: 'a', target: a, composition: numeric({ value: read(SENSOR, 'value') }) }],
      ),
    ).toEqual([])
  })

  it('excludes a disabled feature from cycles and restores the cycle when re-enabled', () => {
    const a = composedDeviceRef('a')
    const b = composedDeviceRef('b')
    const peer = { blockId: 'b', target: b, composition: numeric({ value: read(a, 'value') }) }

    expect(
      findCompositionCycles(
        { blockId: 'a', target: a, composition: numeric({ value: read(b, 'value') }, false) },
        [peer],
      ),
    ).toEqual([])
    expect(
      findCompositionCycles(
        { blockId: 'a', target: a, composition: numeric({ value: read(b, 'value') }, true) },
        [peer],
      ),
    ).toHaveLength(1)
  })

  it('accepts two fields of the same device where A reads B and B reads a third device', () => {
    const a = composedDeviceRef('a')
    expect(
      findCompositionCycles(
        {
          blockId: 'a',
          target: a,
          composition: numeric({ value: read(SENSOR, 'value'), lastFetchedAt: read(a, 'value') }),
        },
        [],
      ),
    ).toEqual([])
  })

  it('finds a 3-hop cycle through two other stored compositions, naming every hop in order', () => {
    const a = composedDeviceRef('a')
    const b = composedDeviceRef('b')
    const c = composedDeviceRef('c')
    const cycles = findCompositionCycles(
      { blockId: 'a', target: a, composition: numeric({ value: read(b, 'value') }) },
      [
        { blockId: 'b', target: b, composition: numeric({ value: read(c, 'value') }) },
        { blockId: 'c', target: c, composition: numeric({ value: read(a, 'value') }) },
      ],
    )
    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.path).toEqual([
      key(b, 'value'),
      key(c, 'value'),
      key(a, 'value'),
      key(b, 'value'),
    ])
  })

  it('accepts a diamond: two sources share one origin and reconverge, no cycle', () => {
    const a = composedDeviceRef('a')
    const b = composedDeviceRef('b')
    const d = composedDeviceRef('d')
    expect(
      findCompositionCycles(
        {
          blockId: 'd',
          target: d,
          composition: numeric({
            value: expression({ x: read(a, 'value'), y: read(b, 'value') }, 'x + y'),
          }),
        },
        [
          { blockId: 'a', target: a, composition: numeric({ value: read(SENSOR, 'value') }) },
          { blockId: 'b', target: b, composition: numeric({ value: read(SENSOR, 'value') }) },
        ],
      ),
    ).toEqual([])
  })

  it('finds a cycle through an expression binding, not only a `from` source', () => {
    const a = composedDeviceRef('a')
    const b = composedDeviceRef('b')
    const cycles = findCompositionCycles(
      {
        blockId: 'a',
        target: a,
        composition: numeric({ value: expression({ x: read(b, 'value') }, 'x') }),
      },
      [{ blockId: 'b', target: b, composition: numeric({ value: read(a, 'value') }) }],
    )
    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.path).toEqual([key(b, 'value'), key(a, 'value'), key(b, 'value')])
  })

  describe('the candidate always replaces a stored peer with the same target', () => {
    const a = composedDeviceRef('a')
    const b = composedDeviceRef('b')
    // The stored (about-to-be-replaced) version of `a`: reads the sensor, not `b`.
    const storedAOld = {
      blockId: 'a',
      target: a,
      composition: numeric({ value: read(SENSOR, 'value') }),
    }
    // `b` already reads `a` — unaffected by the edit.
    const storedB = { blockId: 'b', target: b, composition: numeric({ value: read(a, 'value') }) }
    // The candidate is the NEW version of `a`: it now reads `b` instead of the sensor,
    // which closes a cycle with `storedB` (a → b → a) that did not exist before.
    const candidate = { blockId: 'a', target: a, composition: numeric({ value: read(b, 'value') }) }

    it('refuses the cycle the edit introduces — old-version peer first', () => {
      const cycles = findCompositionCycles(candidate, [storedAOld, storedB])
      expect(cycles).toHaveLength(1)
      expect(cycles[0]?.path).toEqual([key(b, 'value'), key(a, 'value'), key(b, 'value')])
    })

    it('refuses the cycle the edit introduces — old-version peer last', () => {
      const cycles = findCompositionCycles(candidate, [storedB, storedAOld])
      expect(cycles).toHaveLength(1)
      expect(cycles[0]?.path).toEqual([key(b, 'value'), key(a, 'value'), key(b, 'value')])
    })

    it('accepts an update that REMOVES the cycle-causing edge', () => {
      // The edited candidate now reads the sensor again — same shape as `storedAOld` — so
      // the cycle with `storedB` is gone.
      const revertedCandidate = {
        blockId: 'a',
        target: a,
        composition: numeric({ value: read(SENSOR, 'value') }),
      }
      expect(findCompositionCycles(revertedCandidate, [storedB])).toEqual([])
    })
  })

  it('refuses by name when two stored peers (neither the candidate) target the same device', () => {
    const a = composedDeviceRef('a')
    const b = composedDeviceRef('b')
    const candidate = {
      blockId: 'a',
      target: a,
      composition: numeric({ value: read(SENSOR, 'value') }),
    }
    const duplicateB1 = {
      blockId: 'b1',
      target: b,
      composition: numeric({ value: read(SENSOR, 'value') }),
    }
    const duplicateB2 = {
      blockId: 'b2',
      target: b,
      composition: numeric({ value: read(SENSOR, 'value') }),
    }
    expect(() => findCompositionCycles(candidate, [duplicateB1, duplicateB2])).toThrow(
      CompositionGraphError,
    )
    expect(() => findCompositionCycles(candidate, [duplicateB1, duplicateB2])).toThrow(
      /composer\/composed-b/,
    )
  })

  it('two item leaves sharing an inner path are two nodes, each with its own reads', () => {
    const a = composedDeviceRef('a')
    const s1 = { addonId: 'provider-homeassistant', stableId: 'sensor.one' }
    const s2 = { addonId: 'provider-homeassistant', stableId: 'sensor.two' }
    const composition = CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.Generic },
      features: [
        {
          kind: 'fields',
          cap: 'consumables',
          fields: {},
          items: {
            desiccant: { label: 'D', fields: { status: read(s1, 'value') } },
            filter: { label: 'F', fields: { status: read(s2, 'value') } },
          },
        },
      ],
    })
    const edges = compositionEdges({ blockId: 'a', target: a, composition }, [])
    expect([...edges.keys()].sort()).toEqual([
      `${a.addonId}/${a.stableId}#consumables.items[desiccant].status`,
      `${a.addonId}/${a.stableId}#consumables.items[filter].status`,
    ])
    expect(edges.get(`${a.addonId}/${a.stableId}#consumables.items[filter].status`)).toEqual([
      key(s2, 'value'),
    ])
  })
})

describe('one composition per target — identity is the block id (S2)', () => {
  const food = { addonId: 'provider-homeassistant', stableId: 'food-level' }
  const invert = numeric({ value: read(food, 'value') })

  it('the candidate’s OWN old version (same blockId, same target) is dropped, not refused', () => {
    expect(() =>
      findCompositionCycles({ blockId: 'a', target: food, composition: invert }, [
        { blockId: 'a', target: food, composition: invert },
      ]),
    ).not.toThrow()
  })

  it('ANOTHER block on the same target is refused by name — the case the graph used to eclipse', () => {
    expect(() =>
      findCompositionCycles({ blockId: 'b', target: food, composition: invert }, [
        { blockId: 'a', target: food, composition: invert },
      ]),
    ).toThrow(CompositionGraphError)
    expect(() =>
      findCompositionCycles({ blockId: 'b', target: food, composition: invert }, [
        { blockId: 'a', target: food, composition: invert },
      ]),
    ).toThrow(/block `a` and block `b` both target device `provider-homeassistant\/food-level`/)
  })
})

describe('a customization reads its own target’s NATIVE value (rule 5)', () => {
  const food = { addonId: 'provider-homeassistant', stableId: 'food-level' }
  const onOf = (source: Ref) => ({ kind: 'from', source, cap: 'binary', fieldPath: 'on' })
  const binaryOn = (target: unknown, on: unknown): Composition =>
    CompositionSchema.parse({
      target,
      features: [{ kind: 'fields', cap: 'binary', fields: { on } }],
    })
  const foodOn = `${food.addonId}/${food.stableId}#binary.on`
  // "Invert state": FOOD's binary.on is replaced by an expression over FOOD's own (native) binary.on.
  const customizer = {
    blockId: 'cust',
    target: food,
    composition: binaryOn(
      { kind: 'existing', device: food },
      { kind: 'expression', expr: '!on', bindings: { on: onOf(food) } },
    ),
    replaced: new Set(['binary.on']),
  }
  const reader = composedDeviceRef('r')
  const candidate = {
    blockId: 'r',
    target: reader,
    composition: binaryOn({ kind: 'new', type: DeviceType.Sensor }, onOf(food)),
  }

  it('a peer reading FOOD binary.on gets an edge to the customizer’s composed node', () => {
    const edges = compositionEdges(candidate, [customizer])
    expect(edges.get(`${reader.addonId}/${reader.stableId}#binary.on`)).toEqual([foodOn])
    expect(edges.has(foodOn)).toBe(true)
  })

  it('the customizer’s own read of the field it replaces has no edge — not a cycle', () => {
    expect(compositionEdges(candidate, [customizer]).get(foodOn)).toEqual([])
    expect(findCompositionCycles(customizer, [])).toEqual([])
  })
})

describe('findCandidateCycles — decided per strongly connected component (C-1)', () => {
  const device = { addonId: 'provider-homeassistant', stableId: 'feeder' }
  const q = composedDeviceRef('q')
  const c = composedDeviceRef('c')
  // A customization whose device could not be read: nothing replaced, so its two
  // self-reads (x ↔ y) are a loop of its own — the over-approximation's artefact.
  // Its FIRST field also reads the candidate, which is what closes the real cycle.
  const unreadPeer = {
    blockId: 'p',
    target: device,
    composition: CompositionSchema.parse({
      target: { kind: 'existing', device },
      features: [
        {
          kind: 'fields',
          cap: 'numeric-sensor',
          fields: {
            x: expression({ a: read(device, 'y'), b: read(c, 'value') }, 'a + b'),
            y: expression({ a: read(device, 'x') }, 'a'),
          },
        },
      ],
    }),
    replaced: new Set<string>(),
  }
  const relay = { blockId: 'q', target: q, composition: numeric({ value: read(device, 'y') }) }
  const candidate = { blockId: 'c', target: c, composition: numeric({ value: read(q, 'value') }) }

  it('finds the cycle through the candidate that the per-path DFS reports only by the artefact loop', () => {
    const touchesCandidate = (path: readonly string[]) =>
      path.some((n) => n.startsWith(`${c.addonId}/${c.stableId}#`))
    // The DFS enters the peer first: the only path it names avoids the candidate.
    expect(
      findCompositionCycles(candidate, [unreadPeer, relay]).some((cy) => touchesCandidate(cy.path)),
    ).toBe(false)
    const [found, ...more] = findCandidateCycles(candidate, [unreadPeer, relay])
    expect(more).toEqual([])
    expect(found?.path).toEqual([
      key(c, 'value'),
      key(q, 'value'),
      key(device, 'y'),
      key(device, 'x'),
      key(c, 'value'),
    ])
    expect(found?.component.has(key(device, 'x'))).toBe(true)
  })

  it('a cyclic component with no candidate node is not this save’s cycle', () => {
    const unrelated = {
      blockId: 'c',
      target: c,
      composition: numeric({ value: read(SENSOR, 'value') }),
    }
    expect(findCandidateCycles(unrelated, [unreadPeer, relay])).toEqual([])
  })

  it('a candidate field reading itself is a one-node cycle', () => {
    const self = { blockId: 'c', target: c, composition: numeric({ value: read(c, 'value') }) }
    expect(findCandidateCycles(self, []).map((cy) => cy.path)).toEqual([
      [key(c, 'value'), key(c, 'value')],
    ])
  })
})
