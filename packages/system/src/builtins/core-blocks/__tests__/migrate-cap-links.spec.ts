import type { Composition, CompositionFieldsFeature } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  HOST_ID,
  HOST_REF,
  METER_REF,
  block,
  capLinksWorld,
  compositionOf,
  fromMeter,
} from './cap-links-fixtures.js'

function plain(overrides: Partial<CompositionFieldsFeature> = {}): CompositionFieldsFeature {
  return {
    kind: 'fields',
    cap: 'power-meter',
    fields: {
      power: fromMeter('power'),
      energy: fromMeter('energy'),
      lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
    },
    ...overrides,
  }
}

function composition(...features: CompositionFieldsFeature[]): Composition {
  return { target: { kind: 'existing', device: HOST_REF }, features }
}

describe('CapLinksService.migrate (D1076)', () => {
  it('converts plain identity per-field links of one source into one capLink', async () => {
    const world = capLinksWorld([block('b1', composition(plain()))])
    const report = await world.service.migrate(false)
    expect(report.converted).toEqual([
      {
        deviceId: HOST_ID,
        cap: 'power-meter',
        linkId: 'meter-device',
        source: METER_REF,
        fields: ['power', 'energy', 'lastFetchedAt'],
      },
    ])
    expect(compositionOf(world, 'b1')?.features).toEqual([
      { kind: 'capLink', cap: 'power-meter', linkId: 'meter-device', source: METER_REF },
    ])
  })

  it('converts a partial set too (only power was linked)', async () => {
    const world = capLinksWorld([
      block('b1', composition(plain({ fields: { power: fromMeter('power') } }))),
    ])
    const report = await world.service.migrate(false)
    expect(report.converted.map((c) => c.fields)).toEqual([['power']])
  })

  it('a dry run reports the same and writes nothing', async () => {
    const world = capLinksWorld([block('b1', composition(plain()))])
    const report = await world.service.migrate(true)
    expect(report.converted).toHaveLength(1)
    expect(world.writes).toBe(0)
    expect(compositionOf(world, 'b1')?.features[0]?.kind).toBe('fields')
  })

  it('reports a group with an expression field as mixed, with the reason, and leaves it untouched', async () => {
    const mixed = plain({
      fields: {
        power: fromMeter('power'),
        voltage: { kind: 'expression', expr: 'a * 2', bindings: { a: fromMeter('voltage') } },
      },
    })
    const world = capLinksWorld([block('b1', composition(mixed))])
    const report = await world.service.migrate(false)
    expect(report.converted).toEqual([])
    expect(report.mixed).toEqual([
      { deviceId: HOST_ID, cap: 'power-meter', reasons: ['voltage: a expression source'] },
    ])
    expect(world.writes).toBe(0)
  })

  it('reports a field read from another path as mixed', async () => {
    const world = capLinksWorld([
      block('b1', composition(plain({ fields: { power: fromMeter('energy') } }))),
    ])
    const report = await world.service.migrate(false)
    expect(report.mixed).toHaveLength(1)
    expect(report.converted).toEqual([])
  })

  it('skips a feature an identity link stamped (D1063) and a disabled one', async () => {
    const world = capLinksWorld([
      block(
        'b1',
        composition(plain({ contributedBy: { linkId: 'poe-power:x' } }), plain({ enabled: false })),
      ),
    ])
    const report = await world.service.migrate(false)
    expect(report.skipped).toBe(2)
    expect(report.converted).toEqual([])
    expect(world.writes).toBe(0)
  })

  it('is idempotent: a second run converts nothing and counts the link as already there', async () => {
    const world = capLinksWorld([block('b1', composition(plain()))])
    await world.service.migrate(false)
    const second = await world.service.migrate(false)
    expect(second.converted).toEqual([])
    expect(second.alreadyLinked).toBe(1)
    expect(world.writes).toBe(1)
  })

  it('leaves a cap with no declared project link alone', async () => {
    const world = capLinksWorld([
      block(
        'b1',
        composition(
          plain({
            cap: 'lock-control',
            fields: { state: fromMeter('state') },
          }),
        ),
      ),
    ])
    const report = await world.service.migrate(false)
    expect(report.converted).toEqual([])
    expect(report.mixed).toEqual([])
  })

  it('refuses while the compositions have not loaded', async () => {
    const world = capLinksWorld(null)
    await expect(world.service.migrate(true)).rejects.toThrow(/not loaded/)
  })
})
