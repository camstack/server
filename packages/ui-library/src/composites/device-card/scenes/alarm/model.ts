import type { AlarmArmMode } from '@camstack/types'
import type { CardCommon, CardCommonActions } from '../../shell/model'

export type { AlarmArmMode }

/** What the panel is doing. `pending`: the entry delay before it goes off. */
export type AlarmActivity = 'disarmed' | 'armed' | 'arming' | 'disarming' | 'pending' | 'triggered'

export interface AlarmCardModel {
  readonly common: CardCommon
  readonly activity: AlarmActivity
  readonly since: string | null
  /** The mode it is armed (or arming) in; null when disarmed or not reported. */
  readonly mode: AlarmArmMode | null
  /** The modes the panel declares; the mode row draws Disarmed plus these. */
  readonly modes: readonly AlarmArmMode[]
  /** Arming and disarming ask for the panel's code. */
  readonly requiresCode: boolean
  readonly canArm: boolean
  readonly canDisarm: boolean
}

export interface AlarmCardActions extends CardCommonActions {
  readonly onArm: (mode: AlarmArmMode, code: string | null) => void
  readonly onDisarm: (code: string | null) => void
}
