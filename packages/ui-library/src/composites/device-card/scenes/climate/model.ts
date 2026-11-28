import type { ClimateAction } from '@dominevo/types'
import type { ClimateAmbientActivity } from '../../illustrations/AmbientFx'
import type { ClimateRole } from '../../illustrations/ClimateRoleGlyph'
import type { MenuOption } from '../../parts/MenuButton'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What a climate device is doing: the ambient layer's activity. */
export type ClimateActivity = ClimateAmbientActivity

export interface ClimateChoice {
  readonly value: string | null
  readonly options: readonly MenuOption[]
}

export interface ClimateTarget {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  /** What the setpoint is called under its number: "target", or the preset it belongs to. */
  readonly label: string | null
}

/** A low and a high setpoint held at once (heat below, cool above). */
export interface ClimateRange {
  readonly low: number
  readonly high: number
  readonly min: number
  readonly max: number
  readonly step: number
  /** False when the device reports the band but offers no way to set it. */
  readonly editable: boolean
}

/** A radiator valve; `position` is null when it has not reported yet. */
export interface ClimateValve {
  readonly position: number | null
}

/** Every optional block is null when the device does not declare it. */
export interface ClimateCardModel {
  readonly common: CardCommon
  readonly role: ClimateRole
  readonly on: boolean
  /** False when nothing turns the device on or off (a valve that only reports). */
  readonly canPower: boolean
  readonly activity: ClimateActivity
  /** What the device reports it is doing; null = it does not say (no activity label). */
  readonly action: ClimateAction | null
  /** After the state word: "for 40 min", or the mode when the state is assumed. */
  readonly since: string | null
  /** Room temperature; null when the device does not measure it. */
  readonly current: number | null
  /** Flow temperature of a heat-pump circuit, shown in place of the room's. */
  readonly flow: number | null
  readonly humidity: number | null
  readonly target: ClimateTarget | null
  /** Takes the dial in place of `target` when the device holds a band. */
  readonly range: ClimateRange | null
  readonly valve: ClimateValve | null
  readonly mode: ClimateChoice | null
  readonly fan: ClimateChoice | null
  readonly swing: boolean | null
  readonly swingHorizontal: boolean | null
  readonly preset: ClimateChoice | null
  readonly heatCool: ClimateChoice | null
}

export interface ClimateCardActions extends CardCommonActions {
  readonly onPower: (on: boolean) => void
  readonly onTarget: (value: number) => void
  readonly onMode: (id: string) => void
  readonly onFan: (id: string) => void
  readonly onRange: (low: number, high: number) => void
  readonly onSwing: (on: boolean) => void
  readonly onSwingHorizontal: (on: boolean) => void
  readonly onPreset: (id: string) => void
  readonly onHeatCool: (id: string) => void
}

/** The fan button walks its options in order and wraps. */
export function nextChoice(choice: ClimateChoice): string | null {
  if (choice.options.length === 0) return null
  const at = choice.options.findIndex((o) => o.id === choice.value)
  return choice.options[(at + 1) % choice.options.length]?.id ?? null
}

/**
 * What the device is doing, from the action it reports. The gap between the
 * target and the room is never read: a device that does not say is `unknown`.
 */
export function climateActivityOf(input: {
  readonly on: boolean
  readonly action: ClimateAction | null
}): ClimateActivity {
  if (!input.on) return 'off'
  switch (input.action) {
    case 'heating':
      return 'heat'
    case 'cooling':
      return 'cool'
    case 'idle':
      return 'idle'
    case 'off':
      return 'off'
    default:
      return 'unknown'
  }
}

/** The dial's extras: the hollow marker at the room and, while working, the band to the target. */
export interface ClimateGauge {
  readonly marker: number
  /** Filled between room and target; null unless the device is heating or cooling. */
  readonly band: { readonly from: number; readonly to: number } | null
}

/** Null when there is no single-setpoint dial or no room reading to mark. */
export function climateGauge(
  model: Pick<ClimateCardModel, 'action' | 'current' | 'target' | 'range'>,
): ClimateGauge | null {
  if (model.current === null || model.target === null || model.range !== null) return null
  const working = model.action === 'heating' || model.action === 'cooling'
  return {
    marker: model.current,
    band: working ? { from: model.current, to: model.target.value } : null,
  }
}
