import type { CardCommon, CardCommonActions } from '../../shell/model'
import type { SwitchTimerActions, SwitchTimerModel } from '../../parts/switch-timer-model'

export interface PlugCardModel {
  readonly common: CardCommon
  /** Null when the switch state is not known. */
  readonly on: boolean | null
  readonly since: string | null
  /** Null when the switch declares no timed run. */
  readonly timer: SwitchTimerModel | null
  /** The switch's provider declares a native power cycle (`getOptions().supportsPowerCycle`). */
  readonly powerCycle: boolean
  /** What the scene draws: a wall socket (default) or a LAN port (a PoE port device). */
  readonly art?: 'socket' | 'port'
}

export interface PlugCardActions extends CardCommonActions, SwitchTimerActions {
  readonly onPower: (on: boolean) => void
  /** Cuts and restores the output in one call (`switch.powerCycle`). */
  readonly onPowerCycle: () => void
}
