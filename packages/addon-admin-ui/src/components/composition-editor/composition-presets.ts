/**
 * The presets the create flow offers: a device built from a set of entities
 * the operator names, one slot per entity. A preset is one entry here — its
 * slots, and the function that turns the picks into a composition. The wizard
 * reads only this registry, so a new preset adds no UI code.
 */
import {
  type Composition,
  type CompositionSourceRef,
  type PetFountainCadenceSources,
  type PetFountainPumpCycleSources,
  petFountainFromEntitiesComposition,
} from '@camstack/types'

/** One entity a preset needs. */
export interface PresetSlot {
  readonly key: string
  /** i18n key of the slot's name. */
  readonly labelKey: string
  /** The capability the entity is read or called through; shown as a hint. */
  readonly expectedCap: string
  /** Slots of one group are all picked or none are (an optional pair). Absent = required. */
  readonly optionalGroup?: string
}

export type PresetPicks = Readonly<Record<string, CompositionSourceRef | undefined>>

export interface CompositionPreset {
  readonly id: string
  readonly labelKey: string
  readonly descriptionKey: string
  /** The name the new device starts with, an i18n key. */
  readonly nameKey: string
  readonly slots: readonly PresetSlot[]
  /** The composition for these picks, or null while a required slot is empty. */
  readonly build: (picks: PresetPicks) => Composition | null
}

function pick(picks: PresetPicks, key: string): CompositionSourceRef | undefined {
  return picks[key]
}

const slot = (key: string, expectedCap: string, optionalGroup?: string): PresetSlot => ({
  key,
  labelKey: `preset.petFountain.slot.${key}`,
  expectedCap,
  ...(optionalGroup === undefined ? {} : { optionalGroup }),
})

const PET_FOUNTAIN: CompositionPreset = {
  id: 'pet-fountain',
  labelKey: 'preset.petFountain.label',
  descriptionKey: 'preset.petFountain.description',
  nameKey: 'preset.petFountain.name',
  slots: [
    // What every fountain has: required.
    slot('waterLevel', 'enum-sensor'),
    slot('waterVolume', 'enum-sensor'),
    slot('pump', 'switch'),
    // What a model may have on top: each group is picked whole or not at all.
    slot('pumpInterval', 'switch', 'cycle'),
    slot('pumpOnMinutes', 'control', 'cycle'),
    slot('pumpOffMinutes', 'control', 'cycle'),
    slot('filterDaysRemaining', 'enum-sensor', 'filter'),
    slot('filterChanged', 'button', 'filter'),
    slot('cleaningDaysRemaining', 'enum-sensor', 'cleaning'),
    slot('cleaningDone', 'button', 'cleaning'),
    slot('waterChangeDaysRemaining', 'enum-sensor', 'waterChange'),
    slot('waterChanged', 'button', 'waterChange'),
  ],
  build: (picks) => {
    const waterLevel = pick(picks, 'waterLevel')
    const waterVolume = pick(picks, 'waterVolume')
    const pump = pick(picks, 'pump')
    if (waterLevel === undefined || waterVolume === undefined || pump === undefined) return null
    const pumpCycle = cycleOf(picks)
    const filter = cadenceOf(picks, 'filterDaysRemaining', 'filterChanged')
    const cleaning = cadenceOf(picks, 'cleaningDaysRemaining', 'cleaningDone')
    const waterChange = cadenceOf(picks, 'waterChangeDaysRemaining', 'waterChanged')
    // A group is whole or absent: a half-picked one builds nothing.
    if (
      pumpCycle === 'partial' ||
      filter === 'partial' ||
      cleaning === 'partial' ||
      waterChange === 'partial'
    ) {
      return null
    }
    return petFountainFromEntitiesComposition({
      waterLevel,
      waterVolume,
      pump,
      ...(pumpCycle === null ? {} : { pumpCycle }),
      ...(filter === null ? {} : { filter }),
      ...(cleaning === null ? {} : { cleaning }),
      ...(waterChange === null ? {} : { waterChange }),
    })
  },
}

/** A pair of picks: both, neither (null) or only one (`partial`). */
function cadenceOf(
  picks: PresetPicks,
  daysKey: string,
  changedKey: string,
): PetFountainCadenceSources | null | 'partial' {
  const daysRemaining = pick(picks, daysKey)
  const changed = pick(picks, changedKey)
  if (daysRemaining === undefined && changed === undefined) return null
  return daysRemaining !== undefined && changed !== undefined
    ? { daysRemaining, changed }
    : 'partial'
}

/** The pump duty cycle: all three picks, none (null) or a partial set. */
function cycleOf(picks: PresetPicks): PetFountainPumpCycleSources | null | 'partial' {
  const interval = pick(picks, 'pumpInterval')
  const onMinutes = pick(picks, 'pumpOnMinutes')
  const offMinutes = pick(picks, 'pumpOffMinutes')
  if (interval === undefined && onMinutes === undefined && offMinutes === undefined) return null
  return interval !== undefined && onMinutes !== undefined && offMinutes !== undefined
    ? { interval, onMinutes, offMinutes }
    : 'partial'
}

export const COMPOSITION_PRESETS: readonly CompositionPreset[] = [PET_FOUNTAIN]

export function presetById(id: string | null): CompositionPreset | null {
  return id === null ? null : (COMPOSITION_PRESETS.find((preset) => preset.id === id) ?? null)
}

/** The slots still to fill: required ones, and the rest of an optional group that was started. */
export function missingSlots(preset: CompositionPreset, picks: PresetPicks): readonly PresetSlot[] {
  const started = new Set(
    preset.slots
      .filter((s) => s.optionalGroup !== undefined && picks[s.key] !== undefined)
      .map((s) => s.optionalGroup),
  )
  return preset.slots.filter(
    (s) =>
      picks[s.key] === undefined && (s.optionalGroup === undefined || started.has(s.optionalGroup)),
  )
}

/** The device used as the anchor for suggestions: the first slot picked, in slot order. */
export function firstPick(
  preset: CompositionPreset,
  picks: PresetPicks,
): CompositionSourceRef | null {
  for (const s of preset.slots) {
    const picked = picks[s.key]
    if (picked !== undefined) return picked
  }
  return null
}
