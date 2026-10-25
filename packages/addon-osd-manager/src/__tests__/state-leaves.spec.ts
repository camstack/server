import { ALL_CAPABILITY_DEFINITIONS, type CapabilityDefinition } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { humanizeCapName, sourceOptionsFor } from '../source-catalog.js'
import { readStatePath, stateLeavesOf } from '../state-leaves.js'

function fakeCap(runtimeState: z.ZodObject): CapabilityDefinition {
  const cap: CapabilityDefinition = {
    name: 'fake',
    scope: 'device',
    mode: 'singleton',
    methods: {},
    runtimeState,
  }
  return cap
}

const CAP_WITHOUT_STATE: CapabilityDefinition = {
  name: 'stateless',
  scope: 'system',
  mode: 'singleton',
  methods: {},
}

describe('stateLeavesOf', () => {
  it('lists scalar leaves with their type', () => {
    const leaves = stateLeavesOf(
      fakeCap(
        z.object({
          detected: z.boolean(),
          value: z.number().optional(),
          mode: z.enum(['auto', 'day', 'night']),
          lastFetchedAt: z.number(),
        }),
      ),
    )
    expect(leaves).toEqual([
      { path: 'detected', valueType: 'boolean', enumValues: undefined },
      { path: 'value', valueType: 'number', enumValues: undefined },
      { path: 'mode', valueType: 'enum', enumValues: ['auto', 'day', 'night'] },
    ])
  })

  it('drops bookkeeping fields nobody would put on screen', () => {
    const leaves = stateLeavesOf(fakeCap(z.object({ lastFetchedAt: z.number(), a: z.number() })))
    expect(leaves.map((l) => l.path)).toEqual(['a'])
  })

  it('unwraps default/nullable/readonly wrappers', () => {
    const leaves = stateLeavesOf(
      fakeCap(
        z.object({
          a: z.string().default('x'),
          b: z.number().nullable(),
          c: z.boolean().optional().nullable(),
        }),
      ),
    )
    expect(leaves.map((l) => [l.path, l.valueType])).toEqual([
      ['a', 'string'],
      ['b', 'number'],
      ['c', 'boolean'],
    ])
  })

  it('descends one level into a nested object', () => {
    const leaves = stateLeavesOf(fakeCap(z.object({ net: z.object({ rssi: z.number() }) })))
    expect(leaves.map((l) => l.path)).toEqual(['net.rssi'])
  })

  it('skips arrays and records — they have no single value to burn into a slot', () => {
    const leaves = stateLeavesOf(
      fakeCap(z.object({ items: z.array(z.string()), map: z.record(z.string(), z.number()) })),
    )
    expect(leaves).toEqual([])
  })

  it('returns nothing for a cap with no state at all', () => {
    expect(stateLeavesOf(CAP_WITHOUT_STATE)).toEqual([])
  })

  it('produces leaves for real caps in the shipped catalog', () => {
    const motion = ALL_CAPABILITY_DEFINITIONS.find((c) => c.name === 'motion')
    expect(motion).toBeDefined()
    expect(stateLeavesOf(motion!).length).toBeGreaterThan(0)
  })
})

describe('readStatePath', () => {
  it('reads a top-level key', () => {
    expect(readStatePath({ detected: true }, 'detected')).toBe(true)
  })

  it('reads a nested key', () => {
    expect(readStatePath({ net: { rssi: -60 } }, 'net.rssi')).toBe(-60)
  })

  it('returns undefined for an absent key rather than throwing', () => {
    expect(readStatePath({ a: 1 }, 'b')).toBeUndefined()
    expect(readStatePath({ a: 1 }, 'a.b')).toBeUndefined()
    expect(readStatePath(null, 'a')).toBeUndefined()
  })

  it('distinguishes a stored null from an absent key', () => {
    expect(readStatePath({ a: null }, 'a')).toBeNull()
  })
})

describe('sourceOptionsFor', () => {
  it('puts the camera own values first', () => {
    const options = sourceOptionsFor(
      101,
      [
        { id: 42, name: 'Thermo' },
        { id: 101, name: 'Gate' },
      ],
      new Map([
        [42, ['temperature-sensor']],
        [101, ['temperature-sensor']],
      ]),
    )
    expect(options[0]?.deviceId).toBe(101)
  })

  it('ignores a cap name the shipped catalog does not know', () => {
    const options = sourceOptionsFor(1, [{ id: 1, name: 'X' }], new Map([[1, ['not-a-real-cap']]]))
    expect(options).toEqual([])
  })

  it('labels an option readably', () => {
    expect(humanizeCapName('air-quality-sensor')).toBe('Air Quality Sensor')
  })

  it('never offers gateway / infrastructure caps', () => {
    const options = sourceOptionsFor(
      1,
      [{ id: 1, name: 'Ecowitt Gateway' }],
      new Map([
        [
          1,
          [
            'broker',
            'device-export',
            'mqtt-broker',
            'feature-probe',
            'device-status',
            'battery',
            'temperature-sensor',
          ],
        ],
      ]),
    )
    expect(options.map((o) => `${o.capName}.${o.valuePath}`).toSorted()).toEqual([
      'battery.percentage',
      'temperature-sensor.celsius',
    ])
  })

  it('offers only useful climate-control reads', () => {
    const options = sourceOptionsFor(
      1,
      [{ id: 1, name: 'AC' }],
      new Map([[1, ['climate-control']]]),
    )
    expect(options.map((o) => o.valuePath).toSorted()).toEqual([
      'currentHumidity',
      'currentTemp',
      'mode',
      'target',
      'targetHumidity',
    ])
  })
})
