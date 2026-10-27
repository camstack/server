/**
 * Composition draft templates (Q3) and post-create navigation.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  buildCapabilityLookup,
  compositionSourceKey,
  DeviceType,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
  validateComposition,
  type CompositionSourceDescription,
  type ValidateCompositionContext,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  compositionTemplateDraft,
  convertedSensorTemplateDraft,
  derivedBinaryTemplateDraft,
  formulaTemplatesFor,
  postCreateDestination,
  roomTemplateDraft,
} from '../composition-templates'
import { editorReducer } from '../draft-reducer'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)

function sourcesOfRoom(): ReadonlyMap<string, CompositionSourceDescription> {
  const composition = roomCompositionExample({
    temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
    motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
    occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
  })
  return new Map(
    [...ROOM_EXAMPLE_TEMPERATURE_SOURCES, ...ROOM_EXAMPLE_MOTION_SOURCES].map((ref, i) => [
      compositionSourceKey(ref),
      {
        kind: 'found',
        deviceId: 100 + i,
        caps: new Set(['temperature-sensor', 'motion']),
      },
    ]),
  )
}

describe('composition templates', () => {
  it('Converted sensor fills a new-target draft with one numeric-sensor convert placeholder', () => {
    const draft = convertedSensorTemplateDraft()
    expect(draft.target).toEqual({ kind: 'new', type: DeviceType.Sensor })
    expect(draft.features).toHaveLength(1)
    expect(draft.features[0]?.cap).toBe('numeric-sensor')
    const value = draft.features[0]?.fields.value
    expect(value?.kind).toBe('expression')
    if (value?.kind === 'expression') {
      expect(value.expr).toContain('convert(v')
    }
  })

  it('Room fills presence any-of + temperature avg; validateComposition problems empty against fixture sources', () => {
    const draft = roomTemplateDraft()
    expect(draft.target).toMatchObject({ kind: 'new', type: 'sensor', role: 'temperature-sensor' })
    expect(draft.features.map((f) => f.cap).toSorted()).toEqual(['binary', 'temperature-sensor'])
    const temp = draft.features.find((f) => f.cap === 'temperature-sensor')
    const temperature = temp?.fields.temperature
    expect(temperature?.kind === 'expression' ? temperature.expr : '').toMatch(/avg\(/)
    const binary = draft.features.find((f) => f.cap === 'binary')
    const on = binary?.fields.on
    expect(on?.kind === 'expression' ? on.expr : '').toMatch(/any\(/)

    const composition = roomCompositionExample({
      temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
      motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
      occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
    })
    const ctx: ValidateCompositionContext = {
      lookupCap,
      sources: sourcesOfRoom(),
      self: null,
      blockId: null,
      target: null,
      peers: [],
    }
    const result = validateComposition(composition, ctx)
    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
  })

  it('Derived binary fills a threshold expression on binary.on', () => {
    const draft = derivedBinaryTemplateDraft()
    expect(draft.features[0]?.cap).toBe('binary')
    const on = draft.features[0]?.fields.on
    expect(on?.kind === 'expression' ? on.expr : '').toBe('v > 20')
  })

  it('type step changes draft.target.type before features', () => {
    let draft = compositionTemplateDraft('converted-sensor')
    expect(draft.target.kind === 'new' ? draft.target.type : null).toBe(DeviceType.Sensor)
    draft = editorReducer(draft, { type: 'set-new-type', deviceType: DeviceType.Switch })
    expect(draft.target).toEqual({ kind: 'new', type: DeviceType.Switch })
    expect(draft.features.length).toBeGreaterThan(0)
  })
})

describe('formulaTemplatesFor', () => {
  it('offers the room presence formula on binary.on and the average on temperature temperature', () => {
    const presence = formulaTemplatesFor('binary', 'on').find((template) => template.id === 'room')
    expect(presence?.source.kind === 'expression' ? presence.source.expr : '').toMatch(/any\(/)
    const average = formulaTemplatesFor('temperature-sensor', 'temperature').find(
      (template) => template.id === 'room',
    )
    expect(average?.source.kind === 'expression' ? average.source.expr : '').toMatch(/avg\(/)
  })
})

describe('postCreateDestination', () => {
  it('navigates to device detail when the declaration yields an id', () => {
    expect(postCreateDestination('blk-1', 1901)).toEqual({
      kind: 'device',
      path: '/devices/1901',
    })
  })

  it('stays on the editor when no device id is known', () => {
    expect(postCreateDestination('blk a', null)).toEqual({
      kind: 'editor',
      path: '/build/compositions/blk%20a',
    })
  })
})
