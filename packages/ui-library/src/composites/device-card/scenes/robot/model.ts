import type { RobotActivity } from '../../illustrations/RobotIllustration'
import type { CardCommon, CardCommonActions } from '../../shell/model'

export interface RobotSuction {
  readonly options: readonly string[]
  readonly value: string | null
}

/** The commands the robot binds. */
export interface RobotControls {
  readonly start: boolean
  readonly pause: boolean
  readonly dock: boolean
  /** Ends the task (a vacuum's stop); armed, offered while it cleans or is paused. */
  readonly stop: boolean
  /** Vacuum only: it beeps where it is. */
  readonly locate: boolean
}

export interface RobotCardModel {
  readonly common: CardCommon
  readonly mower: boolean
  readonly activity: RobotActivity
  /** What went wrong, in the device's words, when it is in error. */
  readonly errorLabel: string | null
  /** The status line beside the state: a mower's current code, or how long. */
  readonly since: string | null
  /** A vacuum's suction levels; null when it declares none. */
  readonly suction: RobotSuction | null
  /** 0..100 of the task done (a mower's lawn); null when no task reports it. */
  readonly progress: number | null
  readonly controls: RobotControls
  /** The map the integration renders, when the device has one. */
  readonly mapUrl: string | null
}

export interface RobotCardActions extends CardCommonActions {
  readonly onStart: () => void
  readonly onPause: () => void
  readonly onDock: () => void
  readonly onStop: () => void
  readonly onLocate: () => void
  readonly onSuction: (level: string) => void
}
