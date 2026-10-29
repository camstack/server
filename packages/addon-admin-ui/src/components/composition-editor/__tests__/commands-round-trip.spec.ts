/**
 * A built device's commands survive the editor (D967). Opening a composition
 * that has `commands` and saving it untouched writes nothing and changes no
 * byte; editing an unrelated field keeps every command and every item reset.
 */
import {
  type Composition,
  CompositionSchema,
  type CompositionSourceRef,
  petFountainFromEntitiesComposition,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  compositionWithField,
  compositionWithoutFields,
} from '../../device/customize/override-row/merge-override'
import { planCustomizationSave } from '../../device/customize/customization-save'
import { resolveCustomization } from '../../device/customize/customization-read'
import { commandRows, withRowCommand } from '../command-model'
import { draftFromComposition, draftToComposition } from '../draft-reducer'
import { ALL_CAPABILITY_DEFINITIONS } from '@camstack/types'

const ref = (stableId: string): CompositionSourceRef => ({
  addonId: 'provider-homeassistant',
  stableId,
})

const FOUNTAIN: Composition = petFountainFromEntitiesComposition({
  waterLevel: ref('sensor.level'),
  waterVolume: ref('sensor.volume'),
  pump: ref('switch.pump'),
  pumpInterval: ref('switch.cycle'),
  pumpOnMinutes: ref('number.on'),
  pumpOffMinutes: ref('number.off'),
  lastDrink: ref('sensor.last'),
  currentHourDrink: ref('sensor.hour'),
  last24hDrink: ref('sensor.day'),
  todayDrink: ref('sensor.today'),
  clearDaily: ref('button.clear'),
  filter: { daysRemaining: ref('sensor.filter'), changed: ref('button.filter') },
})

const SELF: CompositionSourceRef = { addonId: 'composer', stableId: 'composed-blk-fountain' }

function commandsOf(composition: Composition, cap: string): unknown {
  const feature = composition.features.find((f) => f.cap === cap)
  return feature?.kind === 'fields' ? feature.commands : undefined
}

function resetOf(composition: Composition): unknown {
  const feature = composition.features.find((f) => f.cap === 'consumables')
  return feature?.kind === 'fields' ? feature.items?.['filter']?.reset : undefined
}

describe('a stored composition with commands, opened and saved untouched', () => {
  it('has commands and a reset to protect', () => {
    expect(
      Object.keys(
        FOUNTAIN.features.flatMap((f) => (f.kind === 'fields' ? [f] : []))[0]?.commands ?? {},
      ),
    ).toHaveLength(5)
    expect(resetOf(FOUNTAIN)).toMatchObject({ kind: 'forward', cap: 'button', method: 'press' })
  })

  it('goes through the editor draft byte for byte', () => {
    const parsed = draftToComposition(draftFromComposition(FOUNTAIN, 'Kitchen fountain'))
    if (!parsed.ok) throw new Error(parsed.problems.join('; '))
    expect(JSON.stringify(parsed.composition)).toBe(JSON.stringify(FOUNTAIN))
  })

  it('goes through the schema the server parses with byte for byte', () => {
    const stored = JSON.parse(JSON.stringify(FOUNTAIN))
    expect(JSON.stringify(CompositionSchema.parse(stored))).toBe(JSON.stringify(FOUNTAIN))
  })

  it('is no write at all when saved unchanged', () => {
    const state = resolveCustomization({
      status: 'success',
      data: {
        state: 'loaded',
        view: {
          block: {
            id: 'blk-fountain',
            name: 'Kitchen fountain',
            code: '',
            enabled: true,
            placement: 'hub',
            createdAt: 1,
            updatedAt: 7,
            createdBy: 'admin',
            status: 'running',
            lastChangedAt: 1,
            source: { kind: 'composition', composition: FOUNTAIN },
          },
          state: { kind: 'answered', state: null },
        },
      },
    })
    const reopened: Composition = CompositionSchema.parse(JSON.parse(JSON.stringify(FOUNTAIN)))
    expect(planCustomizationSave(state, reopened)).toEqual({ kind: 'noop' })
  })
})

describe('editing something else keeps every command', () => {
  it('keeps the commands and the reset when one field is changed', () => {
    const next = compositionWithField(
      FOUNTAIN,
      SELF,
      'pet-fountain',
      'pumpRunning',
      { kind: 'expression', expr: 'true', bindings: {} },
      [],
    )
    expect(commandsOf(next, 'pet-fountain')).toEqual(commandsOf(FOUNTAIN, 'pet-fountain'))
    expect(resetOf(next)).toEqual(resetOf(FOUNTAIN))
  })

  it('keeps the commands when a field is removed', () => {
    const next = compositionWithoutFields(FOUNTAIN, SELF, 'pet-fountain', ['pumpRunning'])
    if (next === null) throw new Error('the composition went away')
    expect(commandsOf(next, 'pet-fountain')).toEqual(commandsOf(FOUNTAIN, 'pet-fountain'))
  })

  it('keeps the feature, and its commands, when the last field is removed', () => {
    const feature = FOUNTAIN.features.find((f) => f.cap === 'pet-fountain')
    if (feature?.kind !== 'fields') throw new Error('no fountain feature')
    const next = compositionWithoutFields(
      FOUNTAIN,
      SELF,
      'pet-fountain',
      Object.keys(feature.fields),
    )
    if (next === null) throw new Error('the composition went away')
    expect(commandsOf(next, 'pet-fountain')).toEqual(commandsOf(FOUNTAIN, 'pet-fountain'))
  })

  it('keeps the other commands when one command changes', () => {
    const feature = FOUNTAIN.features.find((f) => f.cap === 'pet-fountain')
    const def = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === 'pet-fountain')
    if (feature?.kind !== 'fields' || def === undefined) throw new Error('no fountain')
    const row = commandRows(def, feature).find((r) => r.method === 'setPump')
    if (row === undefined) throw new Error('no row')
    const changed = withRowCommand(feature, row, {
      kind: 'forward',
      source: ref('switch.other'),
      cap: 'switch',
      method: 'setState',
    })
    const { setPump: _gone, ...before } = feature.commands ?? {}
    const { setPump: _changed, ...after } = changed.commands ?? {}
    expect(after).toEqual(before)
    expect(changed.commands?.['setPump']).toMatchObject({ source: ref('switch.other') })
  })
})
