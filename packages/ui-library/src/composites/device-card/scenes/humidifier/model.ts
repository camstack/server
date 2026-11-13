import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What the humidifier is doing: adding water to the air, taking it out, holding, or off. */
export type HumidifierActivity = 'humidify' | 'dry' | 'idle' | 'off'

export interface HumidifierModeOption {
  readonly id: string
  readonly label: string
}

export interface HumidifierCardModel {
  readonly common: CardCommon
  readonly activity: HumidifierActivity
  readonly since: string | null
  /** The room's humidity, %; null when not reported. */
  readonly currentHumidity: number | null
  /** Null when the device has no setpoint. */
  readonly targetHumidity: number | null
  readonly targetSettable: boolean
  readonly minHumidity: number | null
  readonly maxHumidity: number | null
  readonly mode: string | null
  /** The modes the device offers; empty hides the menu. */
  readonly modes: readonly HumidifierModeOption[]
  /** Null when it cannot be switched; otherwise whether it is on. */
  readonly power: boolean | null
}

export interface HumidifierCardActions extends CardCommonActions {
  readonly onPower: (on: boolean) => void
  readonly onTarget: (humidity: number) => void
  readonly onMode: (mode: string) => void
}
