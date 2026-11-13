import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What the feeder is doing. `fault`: it reports an error and will not feed. */
export type PetFeederActivity = 'feeding' | 'eating' | 'low' | 'ready' | 'fault'

/** A dual-hopper feeder's target; a single hopper is always `single`. */
export type PetFeederHopper = 'single' | 'hopper1' | 'hopper2'

/** A feeder setting the device can switch. Null on the model: not offered. */
export interface PetFeederSettings {
  readonly childLock: boolean | null
  readonly light: boolean | null
  readonly feedSound: boolean | null
  /** Null when the volume cannot be set. */
  readonly volume: number | null
}

export interface PetFeederCardModel {
  readonly common: CardCommon
  readonly activity: PetFeederActivity
  readonly since: string | null
  /** The fault the device reports, shown under the scene. */
  readonly fault: string | null
  /** 0..100 left in the (single) hopper; null when not reported. */
  readonly foodLevel: number | null
  /** Per-hopper levels on a dual-hopper feeder; null on a single hopper. */
  readonly hoppers: readonly [number | null, number | null] | null
  /** The bowl as text ("12 g"); null when not reported. */
  readonly bowl: string | null
  readonly bowlFull: boolean
  readonly lowFood: boolean
  /** The portion the Feed button dispenses, grams. */
  readonly portion: number
  readonly portionMin: number
  readonly portionMax: number
  readonly canFeed: boolean
  readonly canCancel: boolean
  readonly canCallPet: boolean
  /** Mark refilled is offered when the feeder says the action exists. */
  readonly canMarkRefilled: boolean
  /**
   * Power words from the feeder's own status (mains, on battery, offline).
   * Null when it reported nothing extra. PetKit binds no battery cap.
   */
  readonly powerNote: string | null
  readonly settings: PetFeederSettings
}

export interface PetFeederCardActions extends CardCommonActions {
  readonly onFeed: (grams: number, hopper: PetFeederHopper) => void
  readonly onCancelFeed: () => void
  readonly onCallPet: () => void
  readonly onMarkRefilled: () => void
  readonly onChildLock: (on: boolean) => void
  readonly onLight: (on: boolean) => void
  readonly onFeedSound: (on: boolean) => void
  readonly onVolume: (level: number) => void
}

/** What the fountain is doing. */
export type PetFountainActivity = 'running' | 'stopped' | 'empty' | 'fault' | 'unknown'

/** The optional pump-cycle cap: run and rest, in minutes. Null minutes are unknown. */
export interface PetFountainCycle {
  /** Null while the cycle switch has not reported. */
  readonly enabled: boolean | null
  readonly runMinutes: number | null
  readonly restMinutes: number | null
}

export interface PetFountainCardModel {
  readonly common: CardCommon
  readonly activity: PetFountainActivity
  readonly since: string | null
  readonly fault: string | null
  /** 0..100 water in the tank; null when not reported. */
  readonly waterLevel: number | null
  /** Litres in the tank; null when not reported. Drawn as millilitres. */
  readonly waterVolume: number | null
  /**
   * Whether the pump runs. Null is unknown — neither on nor off — and is
   * drawn that way when `pumpSwitchable` is set.
   */
  readonly pump: boolean | null
  /** The binding implements setPump. */
  readonly pumpSwitchable: boolean
  /** Null when the fountain does not compose `pump-cycle`. */
  readonly cycle: PetFountainCycle | null
}

export interface PetFountainCardActions extends CardCommonActions {
  readonly onPump: (on: boolean) => void
  readonly onCycle: (on: boolean) => void
  readonly onRunMinutes: (minutes: number) => void
  readonly onRestMinutes: (minutes: number) => void
}

const LITRES_TO_ML = 1000

/** Tank volume as millilitres. Null stays unknown — never zero. */
export function fountainMillilitres(litres: number | null): string | null {
  return litres === null ? null : `${Math.round(litres * LITRES_TO_ML)} mL`
}

/** Under this much water the pump stops: the level is drawn as a warning. */
export const FOUNTAIN_LOW_PERCENT = 10
