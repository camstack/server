/**
 * When does an alert open a new EPISODE, and which edge of it is announced?
 *
 * The alert centre sends no notification. It stamps every alert it stores with
 * an `episodeId` (`metadata.episodeId`) and announces the opening and the
 * closing of critical and error episodes on the bus; Notification Center turns
 * those into notifications (`alert-critical`, `alert-error`,
 * `alert-critical-resolved`). The identity is what makes a notification
 * once-per-episode: any number of re-emits of an open alert keep the id, a new
 * episode after completion gets a new one.
 */
import {
  type AlertSeverity,
  type AlertStatus,
  isAlertEpisodeOpen,
  isAlertEpisodeSeverity,
} from '@camstack/types'

/** What the policy needs of a stored alert. */
export interface EpisodeView {
  readonly status: AlertStatus
  readonly severity: AlertSeverity
  readonly episodeId: string
  /** The emitter's own episode marker (`metadata.episodeKey`), when it has one. */
  readonly episodeKey?: string
}

export interface NextEpisodeIdInput {
  readonly alertId: string
  readonly previous: EpisodeView | null
  readonly incomingKey: string | undefined
  readonly now: number
}

/**
 * The previous episode continues while its alert is still open and the emitter
 * did not mark a new one; anything else opens `<alertId>@<now>`.
 */
export function nextEpisodeId(input: NextEpisodeIdInput): string {
  const { previous } = input
  if (previous !== null && isAlertEpisodeOpen(previous.status)) {
    const sameKey = input.incomingKey === undefined || input.incomingKey === previous.episodeKey
    if (sameKey) return previous.episodeId
  }
  const minted = `${input.alertId}@${String(input.now)}`
  // A close and a re-open inside one millisecond must still be two episodes.
  return previous !== null && previous.episodeId === minted ? `${minted}+` : minted
}

export type EpisodeEdge = 'raised' | 'resolved'

/**
 * The edge to announce for a write that took `previous` to `next`, or `null`.
 * A re-emit that changes nothing about the episode announces nothing; an
 * escalation from `error` to `critical` inside one episode is announced again
 * (it is a different kind, and the operator opted into it separately).
 */
export function episodeEdge(previous: EpisodeView | null, next: EpisodeView): EpisodeEdge | null {
  const nextOpen = isAlertEpisodeOpen(next.status)
  const continues =
    previous !== null &&
    isAlertEpisodeOpen(previous.status) &&
    previous.episodeId === next.episodeId
  if (nextOpen) {
    if (!isAlertEpisodeSeverity(next.severity)) return null
    if (!continues || previous === null) return 'raised'
    if (!isAlertEpisodeSeverity(previous.severity)) return 'raised'
    return previous.severity === 'error' && next.severity === 'critical' ? 'raised' : null
  }
  if (
    previous !== null &&
    isAlertEpisodeOpen(previous.status) &&
    isAlertEpisodeSeverity(previous.severity)
  ) {
    return 'resolved'
  }
  return null
}
