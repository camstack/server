import type { AmbientActivity } from '../../illustrations/AmbientFx'
import type { ClimateRole } from '../../illustrations/ClimateRoleGlyph'
import type { MenuOption } from '../../parts/MenuButton'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What a climate device is doing: the ambient layer's activity. */
export type ClimateActivity = AmbientActivity

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

/** What the device is doing, when it does not say: read from mode, target and room. */
export function deriveClimateActivity(input: {
  readonly on: boolean
  readonly cooling: boolean
  readonly target: number | null
  readonly current: number | null
  /** The band of a device that holds two setpoints; it wins over `target`. */
  readonly range?: { readonly low: number; readonly high: number } | null
}): ClimateActivity {
  if (!input.on) return 'off'
  if (input.range !== undefined && input.range !== null) {
    if (input.current === null) return 'unknown'
    if (input.current < input.range.low) return 'heat'
    return input.current > input.range.high ? 'cool' : 'idle'
  }
  if (input.current === null || input.target === null) return 'unknown'
  if (input.cooling) return input.target < input.current ? 'cool' : 'idle'
  return input.target > input.current ? 'heat' : 'idle'
}
