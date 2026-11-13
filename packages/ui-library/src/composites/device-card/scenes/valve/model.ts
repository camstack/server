import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What the valve is doing: the cap's own state. */
export type ValveActivity = 'open' | 'opening' | 'closing' | 'closed' | 'stopped'

export interface ValveCardModel {
  readonly common: CardCommon
  readonly activity: ValveActivity
  readonly since: string | null
  /** 0..100 open; null when the valve does not report a position. */
  readonly position: number | null
  /** It accepts a position: the slider on the left. */
  readonly positionable: boolean
  readonly canOpen: boolean
  readonly canClose: boolean
  readonly canStop: boolean
}

export interface ValveCardActions extends CardCommonActions {
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onStop: () => void
  readonly onPosition: (position: number) => void
}
