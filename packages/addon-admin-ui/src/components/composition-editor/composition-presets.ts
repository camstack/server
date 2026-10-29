/**
 * The presets the create flow offers: a device built from a set of entities
 * the operator names, one slot per entity. A preset is one entry here — its
 * slots, and the function that turns the picks into a composition. The wizard
 * reads only this registry, so a new preset adds no UI code.
 */
import {
  type Composition,
  type CompositionSourceRef,
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
    slot('waterLevel', 'enum-sensor'),
    slot('waterVolume', 'enum-sensor'),
    slot('pump', 'switch'),
    slot('pumpInterval', 'switch'),
    slot('pumpOnMinutes', 'control'),
    slot('pumpOffMinutes', 'control'),
    slot('lastDrink', 'enum-sensor'),
    slot('currentHourDrink', 'enum-sensor'),
    slot('last24hDrink', 'enum-sensor'),
    slot('todayDrink', 'enum-sensor'),
    slot('clearDaily', 'button'),
    slot('filterDaysRemaining', 'enum-sensor', 'filter'),
    slot('filterChanged', 'button', 'filter'),
  ],
  build: (picks) => {
    const waterLevel = pick(picks, 'waterLevel')
    const waterVolume = pick(picks, 'waterVolume')
    const pump = pick(picks, 'pump')
    const pumpInterval = pick(picks, 'pumpInterval')
    const pumpOnMinutes = pick(picks, 'pumpOnMinutes')
    const pumpOffMinutes = pick(picks, 'pumpOffMinutes')
    const lastDrink = pick(picks, 'lastDrink')
    const currentHourDrink = pick(picks, 'currentHourDrink')
    const last24hDrink = pick(picks, 'last24hDrink')
    const todayDrink = pick(picks, 'todayDrink')
    const clearDaily = pick(picks, 'clearDaily')
    const daysRemaining = pick(picks, 'filterDaysRemaining')
    const changed = pick(picks, 'filterChanged')
    if (
      waterLevel === undefined ||
      waterVolume === undefined ||
      pump === undefined ||
      pumpInterval === undefined ||
      pumpOnMinutes === undefined ||
      pumpOffMinutes === undefined ||
      lastDrink === undefined ||
      currentHourDrink === undefined ||
      last24hDrink === undefined ||
      todayDrink === undefined ||
      clearDaily === undefined
    ) {
      return null
    }
    // The filter is a pair: one half alone builds nothing.
    if ((daysRemaining === undefined) !== (changed === undefined)) return null
    return petFountainFromEntitiesComposition({
      waterLevel,
      waterVolume,
      pump,
      pumpInterval,
      pumpOnMinutes,
      pumpOffMinutes,
      lastDrink,
      currentHourDrink,
      last24hDrink,
      todayDrink,
      clearDaily,
      ...(daysRemaining !== undefined && changed !== undefined
        ? { filter: { daysRemaining, changed } }
        : {}),
    })
  },
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
