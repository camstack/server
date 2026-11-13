import type { CardCommon, CardCommonActions } from '../../shell/model'

/** A stateless button (`button`): it has nothing to report, only a press. */
export interface ButtonCardModel {
  readonly common: CardCommon
  /** The binding implements `press`; false draws no command. */
  readonly pressable: boolean
}

export interface ButtonCardActions extends CardCommonActions {
  readonly onPress: () => void
}

/** A script (`script-runner`). */
export interface ScriptCardModel {
  readonly common: CardCommon
  readonly running: boolean
  /** "3 min" since the last run; null when it never ran. */
  readonly lastRun: string | null
  /** The provider's last error message; null when it reported none. */
  readonly lastError: string | null
  readonly runnable: boolean
  readonly stoppable: boolean
}

export interface ScriptCardActions extends CardCommonActions {
  readonly onRun: () => void
  readonly onStop: () => void
}

/** An automation (`automation-control`). */
export interface AutomationCardModel {
  readonly common: CardCommon
  readonly enabled: boolean
  /** Since its last successful run; null when it never ran. */
  readonly lastTriggered: string | null
  readonly lastError: string | null
  /** The binding implements `enable` and `disable`. */
  readonly switchable: boolean
  readonly triggerable: boolean
}

export interface AutomationCardActions extends CardCommonActions {
  readonly onEnabled: (enabled: boolean) => void
  readonly onTrigger: () => void
}

/** The provider's error goes on the reason line, after a failed command's. */
export function withError(common: CardCommon, error: string | null): CardCommon {
  if (error === null || error === '' || common.notice !== null) return common
  return { ...common, notice: error }
}
