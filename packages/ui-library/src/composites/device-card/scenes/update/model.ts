import type { CardCommon, CardCommonActions } from '../../shell/model'

/**
 * `available`: the latest version differs from the installed one. `updatable`
 * on the cap means the device SUPPORTS updates, not that one is pending.
 */
export type UpdatePhase = 'available' | 'installing' | 'current'

export interface UpdateCardModel {
  readonly common: CardCommon
  readonly phase: UpdatePhase
  readonly current: string | null
  readonly available: string | null
  /** The provider's own state word, verbatim; null when it sends none. */
  readonly stateText: string | null
  /** The binding implements `installUpdate`. */
  readonly installable: boolean
}

export interface UpdateCardActions extends CardCommonActions {
  readonly onInstall: () => void
}

export interface UpdateReading {
  readonly currentVersion: string | null
  readonly availableVersion: string | null
  readonly inProgress: boolean
}

export function updatePhaseOf(status: UpdateReading): UpdatePhase {
  if (status.inProgress) return 'installing'
  const { currentVersion, availableVersion } = status
  return availableVersion !== null && currentVersion !== null && availableVersion !== currentVersion
    ? 'available'
    : 'current'
}
