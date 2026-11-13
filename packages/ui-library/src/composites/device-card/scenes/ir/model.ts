import type { CardReading } from '../../parts/Readings'
import type { CardCommon, CardCommonActions, CardTone } from '../../shell/model'

/** What the IR transmitter scene draws. Strings are already translated. */
export interface IrTransmitterCardModel {
  readonly common: CardCommon
  readonly headline: string
  readonly since: string | null
  readonly tone: CardTone
  readonly readings: readonly CardReading[]
  readonly learned: string | null
  readonly learnLabel: string
  readonly learnEnabled: boolean
}

export interface IrTransmitterCardActions extends CardCommonActions {
  readonly onLearn: () => void
}
