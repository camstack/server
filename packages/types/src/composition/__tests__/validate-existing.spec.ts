import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { DeviceType } from '../../device/device-type.js'
import { COMPOSER_ADDON_ID } from '../composition.js'
import {
  buildCapabilityLookup,
  CompositionSchema,
  compositionSourceRefs,
  validateComposition,
  type CompositionSourceDescription,
  type CompositionTargetDescription,
  type ValidateCompositionContext,
  type Composition,
} from '../index.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const HA = 'provider-homeassistant'
const FEEDER = { addonId: HA, stableId: 'ha:b:dev:8dec' }
const FOOD = { addonId: HA, stableId: 'ha:b:dev:8dec-binary_sensor.freshelement_3_food_level' }
/** An HA container WITH a battery entity: it registers `battery` natively (`ha-container-device.ts:225`). */
const CAM = { addonId: HA, stableId: 'ha:b:dev:cam1' }
/** A replaced enum field: EVERY replaced derived field is `unavailable: 'release'`, even one that could say 'unknown' (S1b). */
const CORRECT_CHARGING = {
  kind: 'expression',
  expr: 'c == "none" ? "unknown" : c',
  bindings: { c: { kind: 'from', source: CAM, cap: 'battery', fieldPath: 'charging' } },
} as const
/** The "Invert state" replace case: a non-nullable boolean → `unavailable: 'release'` (S1b). */
const INVERT_ON = {
  kind: 'expression',
  expr: '!on',
  bindings: { on: { kind: 'from', source: FOOD, cap: 'binary', fieldPath: 'on' } },
} as const

const DESCRIBED_SOURCES: readonly (readonly [string, CompositionSourceDescription])[] = [
  [`${HA}/${FOOD.stableId}`, { kind: 'found', deviceId: 51, caps: new Set(['binary']) }],
  [`${HA}/${CAM.stableId}`, { kind: 'found', deviceId: 52, caps: new Set(['battery']) }],
]

function ctx(target: CompositionTargetDescription, self = FEEDER): ValidateCompositionContext {
  return {
    lookupCap,
    self,
    blockId: null,
    peers: [],
    target,
    // The SELF device is never a described source: production filters it out of
    // `describeSources`, so only the self-read branch can resolve a read of it.
    sources: new Map(
      DESCRIBED_SOURCES.filter(([key]) => key !== `${self.addonId}/${self.stableId}`),
    ),
  }
}
const found = (
  nativeCaps: Record<string, string>,
  type = DeviceType.Container,
): CompositionTargetDescription => ({
  kind: 'found',
  deviceId: 50,
  type,
  nativeCaps: new Map(Object.entries(nativeCaps)),
})

describe('per-feature enablement (D670)', () => {
  const MISSING = { addonId: HA, stableId: 'missing-source' }
  const doorbell = (enabled: boolean, source = FOOD): Composition =>
    CompositionSchema.parse({
      target: { kind: 'existing', device: CAM },
      features: [
        {
          kind: 'fields',
          cap: 'doorbell',
          enabled,
          fields: {
            lastPressedAt: {
              kind: 'from',
              source,
              cap: 'binary',
              fieldPath: 'lastChangedAt',
            },
            pressCountSinceStart: { kind: 'expression', expr: '0', bindings: {} },
          },
        },
      ],
    })

  it('keeps a disabled feature serialized but plans no fields, events, features, or sources', () => {
    const composition = doorbell(false)
    const verdict = validateComposition(composition, ctx(found({}, DeviceType.Camera), CAM))

    expect(composition.features[0]?.enabled).toBe(false)
    expect(verdict.ok).toBe(true)
    expect(verdict.fields).toEqual([])
    expect(verdict.events).toEqual([])
    expect(verdict.features).toEqual([])
    expect(compositionSourceRefs(composition)).toEqual([])
  })

  it('restores missing-source validation when the feature is re-enabled', () => {
    const disabled = validateComposition(
      doorbell(false, MISSING),
      ctx(found({}, DeviceType.Camera), CAM),
    )
    const enabled = validateComposition(
      doorbell(true, MISSING),
      ctx(found({}, DeviceType.Camera), CAM),
    )

    expect(disabled.ok).toBe(true)
    expect(enabled.problems.map((problem) => problem.code)).toContain('source-unreadable')
  })

  it.each([
    [
      {
        kind: 'fields',
        cap: 'not-a-capability',
        enabled: false,
        fields: {},
      },
      'unknown-capability',
    ],
    [
      {
        kind: 'fields',
        cap: 'doorbell',
        enabled: false,
        fields: { notAField: { kind: 'expression', expr: '0', bindings: {} } },
      },
      'unknown-field',
    ],
  ])('still validates a disabled feature structurally: %s', (feature, code) => {
    const composition = CompositionSchema.parse({
      target: { kind: 'existing', device: CAM },
      features: [feature],
    })
    const verdict = validateComposition(composition, ctx(found({}, DeviceType.Camera), CAM))

    expect(verdict.ok).toBe(false)
    expect(verdict.problems.map((problem) => problem.code)).toContain(code)
  })

  it('still refuses duplicate capabilities when one feature is disabled', () => {
    const parsed = CompositionSchema.safeParse({
      target: { kind: 'existing', device: CAM },
      features: [
        {
          kind: 'fields',
          cap: 'doorbell',
          enabled: false,
          fields: {},
        },
        {
          kind: 'fields',
          cap: 'doorbell',
          fields: {},
        },
      ],
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.message).toContain('composed twice')
  })
})

describe('existing targets (D663, D944)', () => {
  it('a bound native cap is refused by name — an add and a new device still plan (D944)', () => {
    const native = CompositionSchema.parse({
      target: { kind: 'existing', device: CAM },
      features: [{ kind: 'fields', cap: 'battery', fields: { charging: CORRECT_CHARGING } }],
    })
    const refused = validateComposition(native, ctx(found({ battery: HA }), CAM))
    expect(refused.features).toEqual([])
    expect(refused.fields).toEqual([])
    expect(refused.problems).toEqual([
      {
        code: 'native-capability-replace',
        path: 'features[0]',
        message: expect.stringContaining('device 50'),
      },
    ])
    expect(refused.problems[0]?.message).toContain('battery')

    const added = CompositionSchema.parse({
      target: { kind: 'existing', device: FEEDER },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: { level: { kind: 'expression', expr: 'null', bindings: {} } },
        },
      ],
    })
    const addPlan = validateComposition(added, ctx(found({})))
    expect(addPlan.problems.map((p) => p.code)).not.toContain('native-capability-replace')
    expect(addPlan.features).toEqual([{ featureIndex: 0, cap: 'battery', mode: 'add' }])

    const built = CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.Sensor, role: 'temperature-sensor' },
      features: [
        {
          kind: 'fields',
          cap: 'temperature-sensor',
          fields: {
            temperature: { kind: 'expression', expr: '21', bindings: {} },
            lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
          },
        },
      ],
    })
    const builtPlan = validateComposition(built, ctx(found({})))
    expect(builtPlan.problems).toEqual([])
    expect(builtPlan.features).toEqual([
      { featureIndex: 0, cap: 'temperature-sensor', mode: 'new' },
    ])
  })

  it('refusing a native override does not report a cycle', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: CAM },
      features: [{ kind: 'fields', cap: 'battery', fields: { charging: CORRECT_CHARGING } }],
    })
    const codes = validateComposition(c, ctx(found({ battery: HA }), CAM)).problems.map(
      (p) => p.code,
    )
    expect(codes).toEqual(['native-capability-replace'])
  })

  it('a feature on a native binary is refused, not planned as a replace (D944)', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FOOD },
      features: [{ kind: 'fields', cap: 'binary', fields: { on: INVERT_ON } }],
    })
    const v = validateComposition(c, ctx(found({ binary: HA }, DeviceType.Sensor), FOOD))
    expect(v.features).toEqual([])
    expect(v.problems.map((p) => p.code)).toEqual(['native-capability-replace'])
  })

  it('an unbound cap is ADD and gets the full new-device checks against the target type', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FEEDER },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: {
            level: { kind: 'expression', expr: 'null', bindings: {} },
          },
        },
      ],
    })
    const codes = validateComposition(c, ctx(found({}))).problems.map((p) => p.code)
    expect(codes).toContain('missing-field') // charging, sleeping, lastUpdated
    expect(codes).not.toContain('wrong-device-type') // Container is in battery.deviceTypes (Task 1)
  })

  it('a native battery override is refused; the same field ADDED is not-replaceable (D944, S1b)', () => {
    // `sleeping` is a non-nullable boolean. Feed it from a source so it is `derived`.
    const feature = {
      kind: 'fields',
      cap: 'battery',
      fields: { sleeping: { kind: 'from', source: FOOD, cap: 'binary', fieldPath: 'on' } },
    }
    const replace = validateComposition(
      CompositionSchema.parse({
        target: { kind: 'existing', device: FEEDER },
        features: [feature],
      }),
      ctx(found({ battery: HA })),
    )
    expect(replace.features).toEqual([])
    expect(replace.problems.map((p) => p.code)).toEqual(['native-capability-replace'])
    const add = validateComposition(
      CompositionSchema.parse({
        target: { kind: 'existing', device: FEEDER },
        features: [
          {
            ...feature,
            fields: {
              ...feature.fields,
              level: { kind: 'expression', expr: 'null', bindings: {} },
              charging: { kind: 'expression', expr: '"unknown"', bindings: {} },
              lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
            },
          },
        ],
      }),
      ctx(found({})),
    )
    expect(add.problems.map((p) => [p.code, p.path])).toEqual([
      ['not-replaceable', 'features[0].fields.sleeping'],
    ])
  })

  it('a CONSTANT or CLOCK owned field is exempt from not-replaceable — it reads nothing (S1)', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FEEDER },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: {
            sleeping: { kind: 'expression', expr: 'false', bindings: {} },
            lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
          },
        },
      ],
    })
    const v = validateComposition(c, ctx(found({})))
    expect(v.problems.map((p) => p.code)).not.toContain('not-replaceable')
    expect(v.problems.map((p) => p.code)).not.toContain('native-capability-replace')
    expect(v.fields.map((f) => [f.path, f.role, f.unavailable])).toEqual([
      ['sleeping', 'constant', 'offline'],
      ['lastUpdated', 'clock', 'offline'],
    ])
  })

  it('allows an accumulator field on an added capability over an existing target', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: CAM },
      features: [
        {
          kind: 'fields',
          cap: 'doorbell',
          fields: {
            lastPressedAt: { kind: 'expression', expr: 'null', bindings: {} },
            pressCountSinceStart: {
              kind: 'expression',
              expr: 'count(lastChangedAt)',
              bindings: {
                lastChangedAt: {
                  kind: 'from',
                  source: FOOD,
                  cap: 'binary',
                  fieldPath: 'lastChangedAt',
                },
              },
            },
          },
        },
      ],
    })
    const verdict = validateComposition(c, ctx(found({}, DeviceType.Camera), CAM))

    expect(verdict.problems).toEqual([])
    expect(verdict.features).toEqual([{ featureIndex: 0, cap: 'doorbell', mode: 'add' }])
    expect(verdict.fields.find((field) => field.path === 'pressCountSinceStart')).toMatchObject({
      role: 'accumulator',
      unavailable: 'offline',
    })

    const replaced = validateComposition(c, ctx(found({ doorbell: HA }, DeviceType.Camera), CAM))
    expect(replaced.features).toEqual([])
    expect(replaced.problems.map((p) => p.code)).toEqual(['native-capability-replace'])
  })

  it('ADDED derived fields map unavailable to null when nullable, else to the enum’s unknown; the SAME fields REPLACED are release (S1 / S1b)', () => {
    const derived = {
      level: {
        kind: 'expression',
        expr: 'on ? 100 : null',
        bindings: { on: { kind: 'from', source: FOOD, cap: 'binary', fieldPath: 'on' } },
      },
      charging: {
        kind: 'expression',
        expr: 'on ? "dc" : "unknown"',
        bindings: { on: { kind: 'from', source: FOOD, cap: 'binary', fieldPath: 'on' } },
      },
    }
    const added = validateComposition(
      CompositionSchema.parse({
        target: { kind: 'existing', device: FEEDER },
        features: [
          {
            kind: 'fields',
            cap: 'battery',
            fields: {
              ...derived,
              sleeping: { kind: 'expression', expr: 'false', bindings: {} },
              lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
            },
          },
        ],
      }),
      ctx(found({})),
    )
    expect(added.problems).toEqual([])
    expect(added.fields.map((f) => [f.path, f.unavailable])).toEqual([
      ['level', 'null'],
      ['charging', 'unknown'],
      ['sleeping', 'offline'],
      ['lastUpdated', 'offline'],
    ])
    const replaced = validateComposition(
      CompositionSchema.parse({
        target: { kind: 'existing', device: FEEDER },
        features: [{ kind: 'fields', cap: 'battery', fields: derived }],
      }),
      ctx(found({ battery: HA })),
    )
    expect(replaced.features).toEqual([])
    expect(replaced.problems.map((p) => p.code)).toEqual(['native-capability-replace'])
  })

  it('a target that is gone or unreadable refuses the save by name', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FEEDER },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: { level: { kind: 'expression', expr: 'null', bindings: {} } },
        },
      ],
    })
    expect(validateComposition(c, ctx({ kind: 'absent' })).problems.map((p) => p.code)).toContain(
      'target-missing',
    )
    expect(
      validateComposition(c, ctx({ kind: 'unreadable', error: 'x' })).problems.map((p) => p.code),
    ).toContain('target-unreadable')
    const missing = validateComposition(c, ctx({ kind: 'absent' })).problems
    expect(missing.find((p) => p.code === 'target-missing')?.message).toContain(
      `${HA}/${FEEDER.stableId}`,
    )
  })

  it('a second customization of the SAME device by another block is duplicate-target; the same block’s old version is not (S2)', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FOOD },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: {
            level: { kind: 'expression', expr: 'null', bindings: {} },
            charging: { kind: 'expression', expr: '"unknown"', bindings: {} },
            sleeping: { kind: 'expression', expr: 'false', bindings: {} },
            lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
          },
        },
      ],
    })
    const stored = {
      blockId: 'blk-old',
      target: FOOD,
      composition: c,
      replaced: new Set<string>(),
    }
    const asOther = validateComposition(c, {
      ...ctx(found({ binary: HA }, DeviceType.Sensor), FOOD),
      blockId: 'blk-new',
      peers: [stored],
    })
    expect(asOther.problems.map((p) => p.code)).toEqual(['duplicate-target'])
    const asSelf = validateComposition(c, {
      ...ctx(found({ binary: HA }, DeviceType.Sensor), FOOD),
      blockId: 'blk-old',
      peers: [stored],
    })
    expect(asSelf.problems).toEqual([])
  })

  it('a CREATE (no block id, no self yet) of a second customization is refused too — the target is the device', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FOOD },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: {
            level: { kind: 'expression', expr: 'null', bindings: {} },
            charging: { kind: 'expression', expr: '"unknown"', bindings: {} },
            sleeping: { kind: 'expression', expr: 'false', bindings: {} },
            lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
          },
        },
      ],
    })
    const stored = { blockId: 'blk-old', target: FOOD, composition: c }
    const created = validateComposition(c, {
      ...ctx(found({ binary: HA }, DeviceType.Sensor)),
      self: null,
      blockId: null,
      peers: [stored],
    })
    expect(created.problems.map((p) => p.code)).toEqual(['duplicate-target'])
  })

  it('a cap the COMPOSER grafted earlier is not native — it is ADD, not replace', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FEEDER },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: {
            level: { kind: 'expression', expr: 'null', bindings: {} },
          },
        },
      ],
    })
    const v = validateComposition(c, ctx(found({ battery: COMPOSER_ADDON_ID })))
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'battery', mode: 'add' }])
    expect(v.problems.map((p) => p.code)).toContain('missing-field')
  })

  it('a self-read of a cap the target does not serve natively is refused by name (rule 5)', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FOOD },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: {
            level: {
              kind: 'from',
              source: FOOD,
              cap: 'humidity-sensor',
              fieldPath: 'humidity',
            },
          },
        },
      ],
    })
    const v = validateComposition(c, ctx(found({ binary: HA }, DeviceType.Sensor), FOOD))
    expect(v.problems.map((p) => p.code)).toContain('source-capability-missing')
    expect(v.problems.map((p) => p.code)).not.toContain('native-capability-replace')
  })

  it('a self-read of a native field this composition does not compose is the native value', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: CAM },
      features: [
        {
          kind: 'fields',
          cap: 'doorbell',
          fields: {
            lastPressedAt: { kind: 'from', source: CAM, cap: 'binary', fieldPath: 'lastChangedAt' },
            pressCountSinceStart: { kind: 'expression', expr: '0', bindings: {} },
          },
        },
      ],
    })
    const v = validateComposition(c, ctx(found({ binary: HA }, DeviceType.Camera), CAM))
    expect(v.problems).toEqual([])
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'doorbell', mode: 'add' }])
  })

  it('a self-read of an ADDED field is the composition’s own output (slice-1 own-field rule)', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FEEDER },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: {
            level: {
              kind: 'expression',
              expr: 't > 0 ? 50 : null',
              bindings: {
                t: { kind: 'from', source: FEEDER, cap: 'battery', fieldPath: 'lastUpdated' },
              },
            },
            charging: { kind: 'expression', expr: '"unknown"', bindings: {} },
            sleeping: { kind: 'expression', expr: 'false', bindings: {} },
            lastUpdated: { kind: 'expression', expr: 'now', bindings: {} },
          },
        },
      ],
    })
    const v = validateComposition(c, ctx(found({})))
    expect(v.problems).toEqual([])
    expect(v.fields.find((f) => f.path === 'level')?.unavailable).toBe('null')
  })

  it('a base device cap stays not-composable on an existing target, although it is native there (rule 4)', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: FEEDER },
      features: [{ kind: 'fields', cap: 'device-status', fields: {} }],
    })
    const v = validateComposition(c, ctx(found({ 'device-status': HA })))
    expect(v.problems.map((p) => [p.code, p.path])).toEqual([['not-composable', 'features[0].cap']])
  })

  describe('item leaves follow the same per-mode unavailable mapping (rule 3)', () => {
    const on = { kind: 'from', source: FOOD, cap: 'binary', fieldPath: 'on' } as const
    const consumables = (itemFields: Record<string, unknown>) =>
      CompositionSchema.parse({
        target: { kind: 'existing', device: FEEDER },
        features: [
          {
            kind: 'fields',
            cap: 'consumables',
            fields: {
              lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
              lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
            },
            items: { desiccant: { label: 'Desiccant', fields: itemFields } },
          },
        ],
      })
    const nullableLeaves = {
      level: { kind: 'expression', expr: 'o ? 100 : null', bindings: { o: on } },
      status: { kind: 'expression', expr: 'o ? "ok" : "replace"', bindings: { o: on } },
    }
    const unit = {
      'remaining.kind': {
        kind: 'expression',
        expr: 'o ? "duration" : "count"',
        bindings: { o: on },
      },
    }
    const itemModes = (v: {
      fields: readonly { path: string; item?: unknown; unavailable: string }[]
    }) => v.fields.filter((f) => f.item !== undefined).map((f) => [f.path, f.unavailable])

    it('on an ADDED cap: nullable leaves → null; a non-nullable derived leaf is not-replaceable', () => {
      const added = validateComposition(consumables(nullableLeaves), ctx(found({})))
      expect(added.problems).toEqual([])
      expect(itemModes(added)).toEqual([
        ['level', 'null'],
        ['status', 'null'],
      ])
      const refused = validateComposition(consumables(unit), ctx(found({})))
      expect(refused.problems.map((p) => [p.code, p.path])).toEqual([
        ['not-replaceable', 'features[0].items.desiccant.fields.remaining.kind'],
      ])
    })

    it('on a native consumables cap the override is refused (D944)', () => {
      const v = validateComposition(
        consumables({ ...nullableLeaves, ...unit }),
        ctx(found({ consumables: HA })),
      )
      expect(v.features).toEqual([])
      expect(v.problems.map((p) => p.code)).toEqual(['native-capability-replace'])
    })
  })
})
