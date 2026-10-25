import type { Composition, CompositionFieldsFeature, CompositionView } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { compositionEditorPath, customizePath } from '../../../../lib/customization-routes'
import { currentComposition, resolveCustomization } from '../customization-read'
import {
  featureOf,
  planCustomizationSave,
  withFeature,
  withoutFeature,
} from '../customization-save'

const FEEDER = { addonId: 'provider-homeassistant', stableId: 'ha:device:petkit-fresh-element-3' }
const BATTERY_SRC = { addonId: 'provider-homeassistant', stableId: 'sensor.freshelement_3_battery' }

const BATTERY: CompositionFieldsFeature = {
  kind: 'fields',
  cap: 'battery',
  fields: {
    percentage: { kind: 'from', source: BATTERY_SRC, cap: 'numeric-sensor', fieldPath: 'value' },
  },
}
const INVERT: CompositionFieldsFeature = {
  kind: 'fields',
  cap: 'binary',
  fields: {
    on: {
      kind: 'expression',
      expr: '!v',
      bindings: { v: { kind: 'from', source: FEEDER, cap: 'binary', fieldPath: 'on' } },
    },
  },
}
const STORED: Composition = { target: { kind: 'existing', device: FEEDER }, features: [BATTERY] }

function view(composition: Composition, updatedAt = 1_790_000_000_000): CompositionView {
  return {
    block: {
      id: 'blk-feeder',
      name: 'customize:provider-homeassistant/ha:device:petkit-fresh-element-3',
      code: '',
      enabled: true,
      placement: 'hub',
      createdAt: 1,
      updatedAt,
      createdBy: 'admin',
      status: 'running',
      lastChangedAt: 1,
      source: { kind: 'composition', composition },
    },
    state: { kind: 'answered', state: null },
  }
}

describe('routes (D676)', () => {
  it('are the one spelling of every href of the slice', () => {
    expect(customizePath(4127)).toBe('/devices/4127?tab=customize')
    expect(compositionEditorPath('a b')).toBe('/build/compositions/a%20b')
  })
})

describe('resolveCustomization — D315', () => {
  it('pending is not none', () => {
    expect(resolveCustomization({ status: 'pending' })).toEqual({ kind: 'pending' })
  })
  it('a failed read is unknown, with its reason', () => {
    expect(resolveCustomization({ status: 'error', error: { message: 'FORBIDDEN' } })).toEqual({
      kind: 'unknown',
      reason: 'FORBIDDEN',
    })
  })
  it('a table that has not loaded is not-loaded, never none', () => {
    expect(
      resolveCustomization({
        status: 'success',
        data: { state: 'not-loaded', reason: 'core_blocks has not loaded yet' },
      }),
    ).toEqual({ kind: 'not-loaded', reason: 'core_blocks has not loaded yet' })
  })
  it('an answered null view is none', () => {
    expect(
      resolveCustomization({ status: 'success', data: { state: 'loaded', view: null } }),
    ).toEqual({ kind: 'none' })
  })
  it('a stored customization is present with its composition', () => {
    const state = resolveCustomization({
      status: 'success',
      data: { state: 'loaded', view: view(STORED) },
    })
    expect(state.kind === 'present' && state.composition).toEqual(STORED)
    expect(currentComposition(state)).toEqual(STORED)
  })
  it('a stored block that is not a composition is unknown, never none', () => {
    const { source: _source, ...block } = view(STORED).block
    const state = resolveCustomization({
      status: 'success',
      data: { state: 'loaded', view: { block, state: { kind: 'answered', state: null } } },
    })
    expect(state).toEqual({ kind: 'unknown', reason: 'block blk-feeder is not a composition' })
    expect(currentComposition(state)).toBeNull()
  })
})

describe('feature merge', () => {
  it('adds a feature, and replaces the feature of the same cap', () => {
    const added = withFeature(STORED, FEEDER, INVERT)
    expect(added.features.map((f) => f.cap)).toEqual(['battery', 'binary'])
    const replaced = withFeature(added, FEEDER, { ...BATTERY, enabled: false })
    expect(featureOf(replaced, 'battery')?.enabled).toBe(false)
    expect(replaced.features.length).toBe(2)
  })
  it('the first feature creates an existing-target composition', () => {
    expect(withFeature(null, FEEDER, BATTERY)).toEqual(STORED)
  })
  it('removing one feature keeps the rest; removing the last leaves nothing to store', () => {
    expect(withoutFeature(withFeature(STORED, FEEDER, INVERT), 'battery')).toEqual({
      target: STORED.target,
      features: [INVERT],
    })
    expect(withoutFeature(STORED, 'battery')).toBeNull()
  })
  it('featureOf answers null for a cap that is not composed', () => {
    expect(featureOf(STORED, 'binary')).toBeNull()
    expect(featureOf(null, 'battery')).toBeNull()
  })
})

describe('planCustomizationSave', () => {
  it.each([
    [{ kind: 'pending' } as const, 'has not been read yet'],
    [{ kind: 'unknown', reason: 'FORBIDDEN' } as const, 'could not be read: FORBIDDEN'],
    [{ kind: 'not-loaded', reason: 'core_blocks has not loaded yet' } as const, 'not loaded yet'],
  ])('refuses to write while the customization is %j (never a blind create)', (state, reason) => {
    const plan = planCustomizationSave(state, STORED)
    expect(plan.kind).toBe('refused')
    expect(plan.kind === 'refused' && plan.reason).toContain(reason)
  })
  it('creates when the device has none — no name, the server derives it', () => {
    expect(planCustomizationSave({ kind: 'none' }, STORED)).toEqual({
      kind: 'create',
      input: { enabled: true, composition: STORED },
    })
  })
  it('nothing to store on a device with none is nothing to do', () => {
    expect(planCustomizationSave({ kind: 'none' }, null)).toEqual({ kind: 'noop' })
  })
  it('updates with the updatedAt it read', () => {
    const state = resolveCustomization({
      status: 'success',
      data: { state: 'loaded', view: view(STORED, 42) },
    })
    const next = withFeature(STORED, FEEDER, INVERT)
    expect(planCustomizationSave(state, next)).toEqual({
      kind: 'update',
      blockId: 'blk-feeder',
      expectedUpdatedAt: 42,
      composition: next,
    })
  })
  it('deletes when nothing is left, and does nothing when nothing changed', () => {
    const state = resolveCustomization({
      status: 'success',
      data: { state: 'loaded', view: view(STORED) },
    })
    expect(planCustomizationSave(state, null)).toEqual({ kind: 'delete', blockId: 'blk-feeder' })
    const reordered: Composition = {
      features: [BATTERY],
      target: { device: FEEDER, kind: 'existing' },
    }
    expect(planCustomizationSave(state, reordered)).toEqual({ kind: 'noop' })
  })
})
