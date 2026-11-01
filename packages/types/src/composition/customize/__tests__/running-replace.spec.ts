/**
 * A native `running` can be REPLACED by an assigned source (D990, a narrow
 * amendment of D944 and D984): the cap declares `running` overridable by the
 * `running` target. The same target ADDS where the device has none.
 */
import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../../generated/capability-router-map.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../../generated/customize-catalog.js'
import { DeviceType } from '../../../device/device-type.js'
import {
  buildCapabilityLookup,
  CompositionSchema,
  validateComposition,
  type CompositionTargetDescription,
  type ValidateCompositionContext,
} from '../../index.js'
import type { CompositionSourceRef } from '../../composition.js'
import { compileScalarOverride } from '../scalar-compile.js'
import { decodeScalarOverride } from '../scalar-decode.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const DISHWASHER: CompositionSourceRef = { addonId: 'bosch', stableId: 'dw-1' }
const PLUG: CompositionSourceRef = { addonId: 'zigbee', stableId: 'plug-1' }

const found = (nativeCaps: Record<string, string>): CompositionTargetDescription => ({
  kind: 'found',
  deviceId: 70,
  type: DeviceType.Dishwasher,
  nativeCaps: new Map(Object.entries(nativeCaps)),
})

function ctx(target: CompositionTargetDescription): ValidateCompositionContext {
  return {
    lookupCap,
    self: DISHWASHER,
    blockId: null,
    peers: [],
    target,
    sources: new Map([
      [
        `${PLUG.addonId}/${PLUG.stableId}`,
        { kind: 'found', deviceId: 71, caps: new Set(['power-meter']) },
      ],
    ]),
  }
}

function compile(apply: 'add' | 'replace') {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'running-state',
      targetId: 'running',
      source: { ...PLUG, cap: 'power-meter', fieldPath: 'power' },
      transform: {
        kind: 'threshold',
        comparison: 'gte',
        threshold: 8,
        startDwellMs: 30000,
        stopDwellMs: 120000,
      },
    },
    device: DISHWASHER,
    apply,
    sourceValueKind: 'number',
    changedAtField: 'wattsChangedAt',
    sourceUnit: 'W',
  })
  if (!out.ok) throw new Error(`compile refused: ${out.reason}`)
  return out.value
}

describe('running-state declares running overridable by the running target', () => {
  it('projects the allow-list', () => {
    expect(CAP_CUSTOMIZE_CATALOG['running-state']?.overridable).toEqual([
      { path: 'running', by: 'running' },
    ])
  })
})

describe('planning a running replace', () => {
  it('plans it as a replace on a native running-state, with no problem', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: DISHWASHER },
      features: [compile('replace')],
    })
    const v = validateComposition(c, ctx(found({ 'running-state': 'bosch' })))
    expect(v.problems).toEqual([])
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'running-state', mode: 'replace' }])
  })

  it('still plans the add where the device has no running-state', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: DISHWASHER },
      features: [compile('add')],
    })
    const v = validateComposition(c, ctx(found({})))
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'running-state', mode: 'add' }])
  })

  it('refuses a native replace that also writes a field outside the declared set', () => {
    const base = compile('replace')
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: DISHWASHER },
      features: [
        {
          ...base,
          fields: { ...base.fields, phase: { kind: 'expression', expr: '"x"', bindings: {} } },
        },
      ],
    })
    const v = validateComposition(c, ctx(found({ 'running-state': 'bosch' })))
    expect(v.problems.map((p) => p.code)).toEqual(['native-capability-replace'])
  })
})

describe('the compiled replace', () => {
  it('keeps the native phase: it writes running, source, lastFetchedAt, since — never phase', () => {
    expect(Object.keys(compile('replace').fields).sort()).toEqual([
      'lastFetchedAt',
      'running',
      'since',
      'source',
    ])
    expect(Object.keys(compile('add').fields)).toContain('phase')
  })

  it.each(['add', 'replace'] as const)('round-trips apply %s through decode', (apply) => {
    const decoded = decodeScalarOverride({
      feature: compile(apply),
      device: DISHWASHER,
      cap: 'running-state',
      targetId: 'running',
    })
    expect(decoded?.apply).toBe(apply)
    expect(decoded?.draft.transform).toMatchObject({ kind: 'threshold', threshold: 8 })
  })
})
