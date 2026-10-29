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
  pumpInterval: ref('interval'),
  pumpOnMinutes: ref('on_minutes'),
  pumpOffMinutes: ref('off_minutes'),
  lastDrink: ref('last_drink'),
  currentHourDrink: ref('hour_drink'),
  last24hDrink: ref('day_drink'),
  todayDrink: ref('today_drink'),
  clearDaily: ref('clear_daily'),
  filter: { daysRemaining: ref('filter_days'), changed: ref('filter_changed') },
}

const CAPS_BY_SOURCE: Readonly<Record<string, string>> = {
  [SOURCES.waterLevel.stableId]: 'enum-sensor',
  [SOURCES.waterVolume.stableId]: 'enum-sensor',
  [SOURCES.pump.stableId]: 'switch',
  [SOURCES.pumpInterval.stableId]: 'switch',
  [SOURCES.pumpOnMinutes.stableId]: 'control',
  [SOURCES.pumpOffMinutes.stableId]: 'control',
  [SOURCES.lastDrink.stableId]: 'enum-sensor',
  [SOURCES.currentHourDrink.stableId]: 'enum-sensor',
  [SOURCES.last24hDrink.stableId]: 'enum-sensor',
  [SOURCES.todayDrink.stableId]: 'enum-sensor',
  [SOURCES.clearDaily.stableId]: 'button',
  [SOURCES.filter?.daysRemaining.stableId ?? '']: 'enum-sensor',
  [SOURCES.filter?.changed.stableId ?? '']: 'button',
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

function evaluate(name: string, values: Readonly<Record<string, string | number | boolean>>) {
  return evaluateCompositionField({
    source: field(SOURCES, 'pet-fountain', name),
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
      new Set(['pet-fountain', 'consumables']),
    )
  })

  it('serves every pet-fountain method with a forward to its entity', () => {
    const feature = petFountainFromEntitiesComposition(SOURCES).features.find(
      (f) => f.kind === 'fields' && f.cap === 'pet-fountain',
    )
    const commands = feature?.kind === 'fields' ? (feature.commands ?? {}) : {}
    expect(Object.keys(commands).toSorted()).toEqual([
      'resetDailyConsumption',
      'setPump',
      'setPumpInterval',
      'setPumpOffMinutes',
      'setPumpOnMinutes',
    ])
    expect(commands['setPumpOnMinutes']).toMatchObject({
      kind: 'forward',
      source: SOURCES.pumpOnMinutes,
      cap: 'control',
      method: 'setValue',
      args: { control: { kind: 'numeric', value: { $input: 'minutes' } } },
    })
    expect(commands['resetDailyConsumption']).toMatchObject({
      source: SOURCES.clearDaily,
      cap: 'button',
      method: 'press',
    })
  })

  it('makes the filter a resettable consumables item forwarding to the changed button', () => {
    const feature = petFountainFromEntitiesComposition(SOURCES).features.find(
      (f) => f.kind === 'fields' && f.cap === 'consumables',
    )
    const reset = feature?.kind === 'fields' ? feature.items?.['filter']?.reset : undefined
    expect(reset).toMatchObject({ source: SOURCES.filter?.changed, cap: 'button', method: 'press' })
  })

  it('has no consumables feature when the fountain has no filter entities', () => {
    const { filter: _filter, ...withoutFilter } = SOURCES
    const composition = petFountainFromEntitiesComposition(withoutFilter)
    expect(composition.features.map((f) => f.kind === 'fields' && f.cap)).toEqual(['pet-fountain'])
    expect(compositionSourceRefs(composition).map((r) => r.stableId)).not.toContain(
      SOURCES.filter?.changed.stableId,
    )
  })

  it('converts millilitres to litres (D944)', () => {
    expect(evaluate('todayDrink', { [SOURCES.todayDrink.stableId]: '420' })).toMatchObject({
      value: 0.42,
    })
  })

  it('leaves the cycle times unknown: a number box value is not a readable field', () => {
    expect(evaluate('pumpOnTime', { [SOURCES.pumpOnMinutes.stableId]: 10 }).value).toBeNull()
  })

  it('reads a non-numeric source as unknown, never zero (D393)', () => {
    const out = evaluate('waterLevel', { [SOURCES.waterLevel.stableId]: 'unavailable' })
    expect(out.value).toBeNull()
    expect(evaluate('empty', { [SOURCES.waterLevel.stableId]: 'unknown' }).value).toBeNull()
    expect(evaluate('empty', { [SOURCES.waterLevel.stableId]: '0' }).value).toBe(true)
    expect(evaluate('empty', { [SOURCES.waterLevel.stableId]: '40' }).value).toBe(false)
  })
})
