import type { SwitchTimerActions, SwitchTimerModel } from '../../parts/switch-timer-model'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/** A heater on a switch (role `switch-heater`, D1033): power and the switch's timed run. */
export interface HeaterCardModel {
  readonly common: CardCommon
  /** Null when the switch state is not known. */
  readonly on: boolean | null
  readonly since: string | null
  readonly timer: SwitchTimerModel | null
}

export interface HeaterCardActions extends CardCommonActions, SwitchTimerActions {
  readonly onPower: (on: boolean) => void
}
