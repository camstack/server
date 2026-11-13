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

/** A step of an install the provider names (`state`), as the card words it. */
export type UpdateStep = 'sending' | 'ready' | 'waiting' | 'applying'

/**
 * What the provider's state word adds to the phase: a known install step, a
 * word the card cannot translate (shown humanised, never as a raw code), or
 * nothing when it only restates the phase (`UP_TO_DATE`, HA's `on` / `off`).
 */
export type UpdateStateWord =
  | { readonly kind: 'step'; readonly step: UpdateStep }
  | { readonly kind: 'other'; readonly text: string }
  | null

/** Provider words, upper-cased. `null` = the word says nothing the phase does not. */
const STATE_WORDS: Readonly<Record<string, UpdateStep | null>> = {
  DELIVER_FIRMWARE_IMAGE: 'sending',
  READY_FOR_UPDATE: 'ready',
  DO_UPDATE_PENDING: 'waiting',
  PERFORMING_UPDATE: 'applying',
  UP_TO_DATE: null,
  NEW_FIRMWARE_AVAILABLE: null,
  IDLE: null,
  UNKNOWN: null,
  ON: null,
  OFF: null,
}

/** `SOME_STEP` → `Some step`. */
function humanised(raw: string): string {
  const words = raw.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function updateStateWordOf(raw: string | null): UpdateStateWord {
  if (raw === null || raw.trim() === '') return null
  const key = raw.trim().toUpperCase()
  if (Object.hasOwn(STATE_WORDS, key)) {
    const step = STATE_WORDS[key] ?? null
    return step === null ? null : { kind: 'step', step }
  }
  return { kind: 'other', text: humanised(raw) }
}
