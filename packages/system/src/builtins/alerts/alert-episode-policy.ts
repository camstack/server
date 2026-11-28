/**
 * When does an alert open a new EPISODE, and which edge of it is announced?
 *
 * The alert centre sends no notification. It stamps every alert it stores with
 * an `episodeId` (`metadata.episodeId`) and announces the opening and the
 * closing of critical and error episodes, and of a device fault at any tier,
 * on the bus; Notification Center turns those into notifications
 * (`alert-critical`, `alert-error`, `alert-critical-resolved`,
 * `device-attention-required` / `-resolved`). The identity is what makes a notification
 * once-per-episode: any number of re-emits of an open alert keep the id, a new
 * episode after completion gets a new one.
 */
import {
  type AlertSeverity,
  type AlertStatus,
  alertEpisodeRank,
  isAlertEpisodeOpen,
} from '@dominevo/types'

/** What the policy needs of a stored alert. */
export interface EpisodeView {
  readonly status: AlertStatus
  readonly severity: AlertSeverity
  /** The alert's category: a device fault is announced at its warning tier too. */
  readonly category: string
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
 * escalation inside one episode (`error` to `critical`, a fault's warning to
 * its error) is announced again: it is a different kind or tier, and the
 * operator opted into it separately. A de-escalation announces nothing.
 */
export function episodeEdge(previous: EpisodeView | null, next: EpisodeView): EpisodeEdge | null {
  const nextOpen = isAlertEpisodeOpen(next.status)
  const previousOpen = previous !== null && isAlertEpisodeOpen(previous.status)
  if (nextOpen) {
    const rank = alertEpisodeRank(next)
    if (rank === 0) return null
    if (previous === null || !previousOpen || previous.episodeId !== next.episodeId) return 'raised'
    return rank > alertEpisodeRank(previous) ? 'raised' : null
  }
  return previous !== null && previousOpen && alertEpisodeRank(previous) > 0 ? 'resolved' : null
}
