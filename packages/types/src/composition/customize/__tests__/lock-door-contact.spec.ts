/**
 * The lock's door-contact extension (D984, a narrow amendment of D944): the ONE
 * Customize extension that REPLACES a native field, because the cap declares
 * that field overridable by that extension. Everything else stays refused.
 */
import { describe, expect, it } from 'vitest'
import { LockStateSchema } from '../../../capabilities/lock-control.cap.js'
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
const LOCK: CompositionSourceRef = {
  addonId: 'provider-x',
  stableId: 'lock-1',
}
const DOOR: CompositionSourceRef = {
  addonId: 'provider-x',
  stableId: 'door-1',
}

const foundLock = (nativeCaps: Record<string, string>): CompositionTargetDescription => ({
  kind: 'found',
  deviceId: 50,
  type: DeviceType.Lock,
  nativeCaps: new Map(Object.entries(nativeCaps)),
})

function ctx(target: CompositionTargetDescription): ValidateCompositionContext {
  return {
    lookupCap,
    self: LOCK,
    blockId: null,
    peers: [],
    target,
    sources: new Map([
      [
        `${DOOR.addonId}/${DOOR.stableId}`,
        { kind: 'found', deviceId: 51, caps: new Set(['contact']) },
      ],
    ]),
  }
}

function compiled() {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'lock-control',
      targetId: 'door-contact',
      source: { ...DOOR, cap: 'contact', fieldPath: 'entryOpen' },
      transform: { kind: 'identity' },
    },
    device: LOCK,
    apply: 'replace',
    sourceValueKind: 'boolean',
    changedAtField: null,
    sourceUnit: null,
  })
  if (!out.ok) throw new Error(`compile refused: ${out.reason}`)
  return out.value
}

describe('door-open is a lock state', () => {
  it('is part of LockStateSchema', () => {
    expect(LockStateSchema.options).toContain('door-open')
  })
})

describe('the lock declares state as overridable by door-contact', () => {
  it('projects the allow-list and a replace target', () => {
    const entry = CAP_CUSTOMIZE_CATALOG['lock-control']
    expect(entry?.overridable).toEqual([{ path: 'state', by: 'door-contact' }])
    const target = entry?.targets.find((t) => t.id === 'door-contact')
    expect(target?.apply).toBe('replace')
    expect(target?.path).toBe('state')
    expect(target?.deviceTypes).toEqual([DeviceType.Lock])
  })
})

describe('planning a replace of a native field', () => {
  const feature = compiled()

  it('plans the declared override on a native lock-control as a replace', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: LOCK },
      features: [feature],
    })
    const v = validateComposition(c, ctx(foundLock({ 'lock-control': 'provider-x' })))
    expect(v.problems).toEqual([])
    expect(v.features).toEqual([{ featureIndex: 0, cap: 'lock-control', mode: 'replace' }])
  })

  it('still refuses a replace of any other field of the same cap', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: LOCK },
      features: [
        {
          kind: 'fields',
          cap: 'lock-control',
          fields: {
            lastChangedAt: { kind: 'expression', expr: '1', bindings: {} },
          },
        },
      ],
    })
    const v = validateComposition(c, ctx(foundLock({ 'lock-control': 'provider-x' })))
    expect(v.problems.map((p) => p.code)).toEqual(['native-capability-replace'])
  })

  it('still refuses a native replace on a cap that declares no override', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'existing', device: LOCK },
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: { level: { kind: 'expression', expr: '1', bindings: {} } },
        },
      ],
    })
    const v = validateComposition(c, ctx(foundLock({ battery: 'provider-x' })))
    expect(v.problems.map((p) => p.code)).toEqual(['native-capability-replace'])
  })
})

describe('the compiled override', () => {
  it('reads the contact RAW state and the lock NATIVE state; jammed wins', () => {
    const state = compiled().fields['state']
    expect(state?.kind).toBe('expression')
    if (state?.kind !== 'expression') return
    expect(state.expr).toBe('native == "jammed" ? native : (x ? "door-open" : native)')
    expect(state.bindings['x']).toMatchObject({
      cap: 'contact',
      fieldPath: 'entryOpen',
    })
    expect(state.bindings['native']).toMatchObject({
      cap: 'lock-control',
      fieldPath: 'state',
    })
  })

  it('round-trips through decode and carries no companions', () => {
    const feature = compiled()
    expect(Object.keys(feature.fields)).toEqual(['state'])
    const decoded = decodeScalarOverride({
      feature,
      device: LOCK,
      cap: 'lock-control',
      targetId: 'door-contact',
    })
    expect(decoded?.draft.source).toMatchObject({
      ...DOOR,
      cap: 'contact',
      fieldPath: 'entryOpen',
    })
    expect(decoded?.apply).toBe('replace')
  })
})
