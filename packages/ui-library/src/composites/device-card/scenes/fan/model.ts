import type { MenuOption } from '../../parts/MenuButton'
import type { SwitchTimerActions, SwitchTimerModel } from '../../parts/switch-timer-model'
import type { CardCommon, CardCommonActions } from '../../shell/model'

export type FanAxisName = 'horizontal' | 'vertical'
export type FanSpin = 'forward' | 'reverse'

/** One oscillation axis as the card edits it, in degrees. */
export interface FanAxisModel {
  readonly oscillating: boolean
  readonly sweepFrom: number
  readonly sweepTo: number
  /** Where the head is held while it does not oscillate. */
  readonly angle: number
  readonly min: number
  readonly max: number
  readonly step: number
}

export interface FanAxisPatch {
  readonly oscillating?: boolean
  readonly sweepFrom?: number
  readonly sweepTo?: number
  readonly angle?: number
}

export interface FanCardModel {
  readonly common: CardCommon
  /** Null when the switch state is not known. */
  readonly on: boolean | null
  readonly since: string | null
  /** 0..100; null for a fan without a speed. */
  readonly speed: number | null
  readonly speedStep: number
  /** The device's presets and the saved ones, in one list; empty hides the menu. */
  readonly presets: readonly MenuOption[]
  readonly preset: string | null
  /** Null when the fan has no direction. */
  readonly direction: FanSpin | null
  /** One oscillation switch; null when the fan has none (or reports axes instead). */
  readonly oscillating: boolean | null
  /** Per-axis oscillation; an axis is null when the fan does not report it. */
  readonly axes: {
    readonly horizontal: FanAxisModel | null
    readonly vertical: FanAxisModel | null
  } | null
  readonly timer: SwitchTimerModel | null
}

export interface FanCardActions extends CardCommonActions, SwitchTimerActions {
  readonly onPower: (on: boolean) => void
  readonly onSpeed: (speed: number) => void
  readonly onPreset: (id: string) => void
  readonly onDirection: (direction: FanSpin) => void
  readonly onOscillating: (oscillating: boolean) => void
  readonly onAxis: (axis: FanAxisName, patch: FanAxisPatch) => void
}

/** The narrowest sweep the card lets an operator set, in degrees. */
export const FAN_MIN_SWEEP = 10

/** "+45°", "-30°", "0°". */
export const signedDegrees = (v: number): string => `${v > 0 ? '+' : ''}${v}°`
