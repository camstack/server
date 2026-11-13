import type { CardCommon, CardCommonActions } from '../../shell/model'

/** `unknown`: the switch has not reported whether it sounds. */
export type SirenActivity = 'sounding' | 'silent' | 'unknown'

export interface SirenCardModel {
  readonly common: CardCommon
  readonly activity: SirenActivity
  readonly since: string | null
  /** The binding can switch it; false draws no command. */
  readonly switchable: boolean
}

export interface SirenCardActions extends CardCommonActions {
  readonly onSound: (on: boolean) => void
}
