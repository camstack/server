import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What the water heater is doing. */
export type WaterHeaterActivity = 'heat' | 'idle' | 'away' | 'off'

export interface WaterHeaterModeOption {
  readonly id: string
  readonly label: string
}

export interface WaterHeaterCardModel {
  readonly common: CardCommon
  readonly activity: WaterHeaterActivity
  readonly since: string | null
  readonly currentTemp: number | null
  readonly targetTemp: number | null
  /** False when the device reports a target it does not let the card change. */
  readonly targetSettable: boolean
  readonly minTemp: number | null
  readonly maxTemp: number | null
  /** The current operation mode; null when the device does not report one. */
  readonly mode: string | null
  /** The modes the device offers; empty hides the menu. */
  readonly modes: readonly WaterHeaterModeOption[]
  /** Null when the device has no away mode. */
  readonly away: boolean | null
  /** Null when the device cannot be switched off and on; otherwise whether it is on. */
  readonly power: boolean | null
}

export interface WaterHeaterCardActions extends CardCommonActions {
  readonly onPower: (on: boolean) => void
  readonly onTarget: (temp: number) => void
  readonly onMode: (mode: string) => void
  readonly onAway: (on: boolean) => void
}
