import type { ClimateActivity } from '../../illustrations/ClimateFx'
import type { ClimateRole } from '../../illustrations/ClimateRoleGlyph'
import type { MenuOption } from '../../parts/MenuButton'
import type { CardCommon, CardCommonActions } from '../../shell/model'

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

/** Every optional block is null when the device does not declare it. */
export interface ClimateCardModel {
  readonly common: CardCommon
  readonly role: ClimateRole
  readonly on: boolean
  readonly activity: ClimateActivity
  /** After the state word: "for 40 min", or the mode when the state is assumed. */
  readonly since: string | null
  /** Room temperature; null when the device does not measure it. */
  readonly current: number | null
  /** Flow temperature of a heat-pump circuit, shown in place of the room's. */
  readonly flow: number | null
  readonly humidity: number | null
  readonly target: ClimateTarget | null
  readonly mode: ClimateChoice | null
  readonly fan: ClimateChoice | null
  readonly swing: boolean | null
  readonly preset: ClimateChoice | null
  readonly heatCool: ClimateChoice | null
}

export interface ClimateCardActions extends CardCommonActions {
  readonly onPower: (on: boolean) => void
  readonly onTarget: (value: number) => void
  readonly onMode: (id: string) => void
  readonly onFan: (id: string) => void
  readonly onSwing: (on: boolean) => void
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
}): ClimateActivity {
  if (!input.on) return 'off'
  if (input.current === null || input.target === null) return 'unknown'
  if (input.cooling) return input.target < input.current ? 'cool' : 'idle'
  return input.target > input.current ? 'heat' : 'idle'
}
