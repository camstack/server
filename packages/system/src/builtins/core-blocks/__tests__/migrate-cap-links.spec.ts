import {
  ALL_CAPABILITY_DEFINITIONS,
  DeviceType,
  buildCapabilityLookup,
  planComposition,
  type Composition,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
  type CompositionTargetDescription,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  HOST_ID,
  HOST_REF,
  METER_REF,
  block,
  capLinksWorld,
  compositionOf,
  fromMeter,
  fullMeterFields,
} from './cap-links-fixtures.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const TARGET: CompositionTargetDescription = {
  kind: 'found',
  deviceId: HOST_ID,
  type: DeviceType.Switch,
  nativeCaps: new Map(),
}

function plain(overrides: Partial<CompositionFieldsFeature> = {}): CompositionFieldsFeature {
  return { kind: 'fields', cap: 'power-meter', fields: fullMeterFields(), ...overrides }
}

function composition(...features: CompositionFieldsFeature[]): Composition {
  return { target: { kind: 'existing', device: HOST_REF }, features }
}

/** What the composer would claim: path, source — the thing a migration must not change. */
function claims(c: Composition): readonly (readonly [string, unknown])[] {
  const plan = planComposition(c, lookupCap, TARGET)
  expect(plan.problems).toEqual([])
  return plan.fields.map((f) => [`${f.cap}.${f.path}`, f.source] as const).sort()
}

describe('CapLinksService.migrate (D1076)', () => {
  it('converts a complete identity set into one capLink and the PLANNED CLAIMS stay identical', async () => {
    const before = composition(plain())
    const world = capLinksWorld([block('b1', before)])
    const report = await world.service.migrate(false)
    expect(report.converted).toHaveLength(1)
    expect(report.converted[0]).toMatchObject({
      deviceId: HOST_ID,
      cap: 'power-meter',
      linkId: 'meter-device',
      source: METER_REF,
    })
    const after = compositionOf(world, 'b1')
    expect(after?.features).toEqual([
      { kind: 'capLink', cap: 'power-meter', linkId: 'meter-device', source: METER_REF },
    ])
    if (after === null) throw new Error('block gone')
    expect(claims(after)).toEqual(claims(before))
  })

  it('does NOT convert a partial set: it would newly take the rest of the cap from the source', async () => {
    const world = capLinksWorld([
      block('b1', composition(plain({ fields: { power: fromMeter('power') } }))),
    ])
    const report = await world.service.migrate(false)
    expect(report.converted).toEqual([])
    expect(report.mixed).toHaveLength(1)
    expect(report.mixed[0]?.reasons[0]).toMatch(/^partial-set: would also take .*energy/)
    expect(world.writes).toBe(0)
  })

  it('a group whose clock reads the source is not an identity of the link (it writes now)', async () => {
    const fields = { ...fullMeterFields(), lastFetchedAt: fromMeter('lastFetchedAt') }
    const world = capLinksWorld([block('b1', composition(plain({ fields })))])
    const report = await world.service.migrate(false)
    expect(report.converted).toEqual([])
    expect(report.mixed[0]?.reasons).toContain(
      'lastFetchedAt: reads the source clock, the link writes now',
    )
  })

  it('a dry run reports the same and writes nothing', async () => {
    const world = capLinksWorld([block('b1', composition(plain()))])
    const report = await world.service.migrate(true)
    expect(report.converted).toHaveLength(1)
    expect(world.writes).toBe(0)
    expect(compositionOf(world, 'b1')?.features[0]?.kind).toBe('fields')
  })

  it('reports a group with an expression field as mixed, with the reason, and leaves it untouched', async () => {
    const fields: Record<string, CompositionFieldSource> = {
      ...fullMeterFields(),
      voltage: {
        kind: 'expression',
        expr: 'a * 2',
        bindings: {
          a: { kind: 'from', source: METER_REF, cap: 'power-meter', fieldPath: 'voltage' },
        },
      },
    }
    const world = capLinksWorld([block('b1', composition(plain({ fields })))])
    const report = await world.service.migrate(false)
    expect(report.converted).toEqual([])
    expect(report.mixed).toEqual([
      { deviceId: HOST_ID, cap: 'power-meter', reasons: ['voltage: a expression source'] },
    ])
    expect(world.writes).toBe(0)
  })

  it('reports a field read from another path as mixed', async () => {
    const fields = { ...fullMeterFields(), power: fromMeter('energy') }
    const world = capLinksWorld([block('b1', composition(plain({ fields })))])
    const report = await world.service.migrate(false)
    expect(report.mixed).toHaveLength(1)
    expect(report.converted).toEqual([])
  })

  it('counts a feature an identity link stamped (D1063) and a disabled one as skipped', async () => {
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

  it('a stamped feature of the same cap left beside the link is reported as mixed, not rewritten', async () => {
    const world = capLinksWorld([
      block(
        'b1',
        composition(
          plain({
            fields: { power: fromMeter('power') },
            contributedBy: { linkId: 'poe-power:x' },
          }),
          plain(),
        ),
      ),
    ])
    const report = await world.service.migrate(true)
    expect(report.converted).toEqual([])
    expect(report.mixed[0]?.reasons).toEqual([
      'overlap: the device link poe-power:x also writes power, which the link would serve',
    ])
  })

  it('a disabled feature of the same cap beside the link does not block the conversion', async () => {
    const world = capLinksWorld([block('b1', composition(plain(), plain({ enabled: false })))])
    const report = await world.service.migrate(false)
    expect(report.converted).toHaveLength(1)
    expect(report.skipped).toBe(1)
    expect(compositionOf(world, 'b1')?.features.map((f) => f.kind)).toEqual(['fields', 'capLink'])
  })

  it('a rewrite the composition API refuses is reported as mixed with its reason, nothing lost', async () => {
    const world = capLinksWorld([block('b1', composition(plain()))])
    world.refuseWith = 'features[0]: link-overlaps-fields'
    const report = await world.service.migrate(false)
    expect(report.converted).toEqual([])
    expect(report.mixed[0]?.reasons).toEqual([
      'the link was refused: features[0]: link-overlaps-fields',
    ])
    expect(compositionOf(world, 'b1')?.features[0]?.kind).toBe('fields')
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
        composition(plain({ cap: 'lock-control', fields: { state: fromMeter('state') } })),
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
