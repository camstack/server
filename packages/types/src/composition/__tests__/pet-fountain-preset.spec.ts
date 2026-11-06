/**
 * `petFountainFromEntitiesComposition` (D967): the preset an operator starts
 * from to BUILD a pet fountain out of loose entities. It validates against the
 * caps a Home Assistant broker really registers, serves every `pet-fountain`
 * method with a forward, converts the sources' units to the stored base units
 * (D944), and reads an unreadable source as unknown, never zero (D393).
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import {
  buildCapabilityLookup,
  type CompositionFieldSource,
  type CompositionSourceDescription,
  type CompositionSourceRef,
  compositionSourceKey,
  compositionSourceRefs,
  evaluateCompositionField,
  petFountainFromEntitiesComposition,
  type PetFountainEntitySources,
  type SourceReader,
  validateComposition,
} from '../index.js'

const lookupCap = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)

const ref = (entity: string): CompositionSourceRef => ({
  addonId: 'provider-homeassistant',
  stableId: `ha:b1:dev:fountain-${entity}`,
})

const SOURCES: PetFountainEntitySources = {
  waterLevel: ref('water_level'),
  waterVolume: ref('water_volume'),
  pump: ref('pump'),
  pumpCycle: {
    interval: ref('interval'),
    onMinutes: ref('on_minutes'),
    offMinutes: ref('off_minutes'),
  },
  filter: { daysRemaining: ref('filter_days'), changed: ref('filter_changed') },
  cleaning: { daysRemaining: ref('cleaning_days'), changed: ref('cleaning_done') },
  waterChange: { daysRemaining: ref('water_days'), changed: ref('water_changed') },
}

const CAPS_BY_SOURCE: Readonly<Record<string, string>> = {
  [SOURCES.waterLevel.stableId]: 'enum-sensor',
  [SOURCES.waterVolume.stableId]: 'enum-sensor',
  [SOURCES.pump.stableId]: 'switch',
  [ref('interval').stableId]: 'switch',
  [ref('on_minutes').stableId]: 'control',
  [ref('off_minutes').stableId]: 'control',
  [ref('filter_days').stableId]: 'enum-sensor',
  [ref('filter_changed').stableId]: 'button',
  [ref('cleaning_days').stableId]: 'enum-sensor',
  [ref('cleaning_done').stableId]: 'button',
  [ref('water_days').stableId]: 'enum-sensor',
  [ref('water_changed').stableId]: 'button',
}

function described(
  caps: Readonly<Record<string, string>>,
): Map<string, CompositionSourceDescription> {
  return new Map(
    Object.entries(caps)
      .filter(([stableId]) => stableId !== '')
      .map(([stableId, cap], i) => [
        compositionSourceKey({ addonId: 'provider-homeassistant', stableId }),
        { kind: 'found', deviceId: 100 + i, caps: new Set([cap]) },
      ]),
  )
}

function validate(sources: PetFountainEntitySources, caps = CAPS_BY_SOURCE) {
  return validateComposition(petFountainFromEntitiesComposition(sources), {
    lookupCap,
    sources: described(caps),
    self: null,
    blockId: null,
    target: null,
    peers: [],
  })
}

function readerOf(values: Readonly<Record<string, string | number | boolean>>): SourceReader {
  return (read) => {
    const value = values[read.source.stableId]
    return value === undefined
      ? { state: 'unavailable', reason: 'no value', fatal: false }
      : { state: 'fresh', value }
  }
}

function field(
  sources: PetFountainEntitySources,
  cap: string,
  name: string,
): CompositionFieldSource {
  const feature = petFountainFromEntitiesComposition(sources).features.find(
    (f) => f.kind === 'fields' && f.cap === cap,
  )
  const source = feature?.kind === 'fields' ? feature.fields[name] : undefined
  if (source === undefined) throw new Error(`no field ${cap}.${name}`)
  return source
}

function commandsOf(sources: PetFountainEntitySources, cap: string) {
  const feature = petFountainFromEntitiesComposition(sources).features.find(
    (f) => f.kind === 'fields' && f.cap === cap,
  )
  return feature?.kind === 'fields' ? (feature.commands ?? {}) : {}
}

function evaluate(
  name: string,
  values: Readonly<Record<string, string | number | boolean>>,
  sources: PetFountainEntitySources = SOURCES,
  cap = 'pet-fountain',
) {
  return evaluateCompositionField({
    source: field(sources, cap, name),
    read: readerOf(values),
    now: 1000,
  })
}

describe('petFountainFromEntitiesComposition', () => {
  it('builds a pet-fountain device that validates against the registered source caps', () => {
    const composition = petFountainFromEntitiesComposition(SOURCES)
    expect(composition.target).toMatchObject({ kind: 'new', type: DeviceType.PetFountain })
    const result = validate(SOURCES)
    expect(result.problems).toEqual([])
    expect(new Set(result.fields.map((f) => f.cap))).toEqual(
      new Set(['pet-fountain', 'pump-cycle', 'consumables']),
    )
  })

  it('serves the pet-fountain method with a forward to its entity, and no drink counters', () => {
    const commands = commandsOf(SOURCES, 'pet-fountain')
    expect(Object.keys(commands)).toEqual(['setPump'])
    const feature = petFountainFromEntitiesComposition(SOURCES).features.find(
      (f) => f.kind === 'fields' && f.cap === 'pet-fountain',
    )
    const fields = feature?.kind === 'fields' ? Object.keys(feature.fields) : []
    expect(fields.toSorted()).toEqual([
      'empty',
      'error',
      'lastFetchedAt',
      'pumpRunning',
      'waterLevel',
      'waterVolume',
    ])
  })

  it('serves every pump-cycle method with a forward to its entity', () => {
    const commands = commandsOf(SOURCES, 'pump-cycle')
    expect(Object.keys(commands).toSorted()).toEqual([
      'setEnabled',
      'setOffMinutes',
      'setOnMinutes',
    ])
    expect(commands['setOnMinutes']).toMatchObject({
      kind: 'forward',
      source: ref('on_minutes'),
      cap: 'control',
      method: 'setValue',
      args: { control: { kind: 'numeric', value: { $input: 'minutes' } } },
    })
    expect(commands['setEnabled']).toMatchObject({ source: ref('interval'), method: 'setState' })
  })

  it('composes no pump-cycle for a fountain without the cycle entities, and still validates', () => {
    const { pumpCycle: _cycle, ...withoutCycle } = SOURCES
    const composition = petFountainFromEntitiesComposition(withoutCycle)
    expect(composition.features.map((f) => f.kind === 'fields' && f.cap)).toEqual([
      'pet-fountain',
      'consumables',
    ])
    expect(compositionSourceRefs(composition).map((r) => r.stableId)).not.toContain(
      ref('interval').stableId,
    )
    expect(validate(withoutCycle).problems).toEqual([])
    expect(Object.keys(commandsOf(withoutCycle, 'pet-fountain'))).toEqual(['setPump'])
  })

  it('makes every maintenance cadence a resettable consumables item forwarding to its button', () => {
    const feature = petFountainFromEntitiesComposition(SOURCES).features.find(
      (f) => f.kind === 'fields' && f.cap === 'consumables',
    )
    const items = feature?.kind === 'fields' ? (feature.items ?? {}) : {}
    expect(Object.keys(items).toSorted()).toEqual(['cleaning', 'filter', 'water-change'])
    expect(items['filter']?.reset).toMatchObject({ source: ref('filter_changed'), method: 'press' })
    expect(items['cleaning']?.reset).toMatchObject({ source: ref('cleaning_done'), cap: 'button' })
    expect(items['water-change']?.reset).toMatchObject({
      source: ref('water_changed'),
      cap: 'button',
    })
  })

  it('has no consumables feature when the fountain has no maintenance entities', () => {
    const { filter: _f, cleaning: _c, waterChange: _w, ...bare } = SOURCES
    const composition = petFountainFromEntitiesComposition(bare)
    expect(composition.features.map((f) => f.kind === 'fields' && f.cap)).toEqual([
      'pet-fountain',
      'pump-cycle',
    ])
    expect(compositionSourceRefs(composition).map((r) => r.stableId)).not.toContain(
      ref('filter_changed').stableId,
    )
  })

  it('converts millilitres to litres (D944)', () => {
    expect(evaluate('waterVolume', { [SOURCES.waterVolume.stableId]: '420' })).toMatchObject({
      value: 0.42,
    })
  })

  it('leaves the cycle times unknown: a number box value is not a readable field', () => {
    expect(
      evaluate('onTime', { [ref('on_minutes').stableId]: 10 }, SOURCES, 'pump-cycle').value,
    ).toBeNull()
  })

  it('reads the cycle switch as the pump-cycle enabled flag', () => {
    expect(
      evaluate('enabled', { [ref('interval').stableId]: true }, SOURCES, 'pump-cycle').value,
    ).toBe(true)
  })

  it('reads a non-numeric source as unknown, never zero (D393)', () => {
    const out = evaluate('waterLevel', { [SOURCES.waterLevel.stableId]: 'unavailable' })
    expect(out.value).toBeNull()
    expect(evaluate('empty', { [SOURCES.waterLevel.stableId]: 'unknown' }).value).toBeNull()
    expect(evaluate('empty', { [SOURCES.waterLevel.stableId]: '0' }).value).toBe(true)
    expect(evaluate('empty', { [SOURCES.waterLevel.stableId]: '40' }).value).toBe(false)
  })
})
