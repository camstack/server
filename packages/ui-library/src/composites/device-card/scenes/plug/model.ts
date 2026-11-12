import type { CardCommon, CardCommonActions } from '../../shell/model'
import type { SwitchTimerActions, SwitchTimerModel } from '../../parts/switch-timer-model'

export interface PlugCardModel {
  readonly common: CardCommon
  /** Null when the switch state is not known. */
  readonly on: boolean | null
  readonly since: string | null
  /** Null when the switch declares no timed run. */
  readonly timer: SwitchTimerModel | null
}

export interface PlugCardActions extends CardCommonActions, SwitchTimerActions {
  readonly onPower: (on: boolean) => void
}
