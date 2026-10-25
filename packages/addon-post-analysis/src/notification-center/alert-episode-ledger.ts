/**
 * NcAlertEpisodeLedger — which alert EPISODES the notification centre has
 * already notified, so that an alert reaches the operator once per episode.
 *
 * The alert centre sends nothing of its own. It announces the opening and the
 * closing of every critical and error alert on the bus (`alert.episode`), and
 * the centre turns the announcement into a system event (`alert-critical`,
 * `alert-error`, `alert-critical-resolved`). A bus event may be dropped (D8),
 * so the centre also RECONCILES from the alerts store at boot and periodically
 * (D11): an open critical alert it has not notified is notified then. This
 * ledger is what makes both paths safe to run together — whichever sees an
 * episode first notifies it, the other finds the row and does nothing.
 *
 * ## One row per OPEN notified episode
 *
 *  - raised (`alert-critical` / `alert-error`) and no row → notify, write row;
 *  - raised and a row → duplicate, nothing (a re-emit never re-notifies);
 *  - an `error` row meeting a `critical` raise of the same episode → notify
 *    (an escalation is news) and the row becomes `alert-critical`;
 *  - resolved and a `alert-critical` row → notify `alert-critical-resolved`,
 *    drop the row; resolved and an `alert-error` row → drop it silently;
 *  - resolved and NO row → nothing: the opening was never announced here, so
 *    its closing has nothing to close.
 *
 * ## D49 — the gate is never widened by a fallible read
 *
 * `admit` reads the in-RAM mirror only. The mirror is refreshed off the event
 * path (boot `load`), a failed load leaves it as it was, and the periodic
 * reconcile does not run until a load has ANSWERED: an empty mirror that was
 * never read would re-notify every open critical alert.
 *
 * The persist is write-behind: a write lost to a crash costs ONE duplicate
 * notification of a still-open episode after the next restart — the direction
 * chosen on purpose, because a lost "your recorder has no space" is worse.
 */
import type { IScopedLogger, NcSystemEventKind } from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../durable/durable-ledger.js'
import { type DurableKindDeps } from '../durable/durable-wiring.js'
import { ncDurableRecordKinds } from './nc-durable-record-kinds.js'

/**
 * @durable class=ledger owner=notification-center
 *   write="an alert episode the centre notified (alert-critical / alert-error); its resolution deletes the row"
 *   retention="a row lives while its episode is open. A row whose alert was pruned by the alert centre's own retention is dropped after NC_ALERT_EPISODE_MAX_AGE_MS by the reconcile, never on absence alone (D49)."
 */
const NC_ALERT_EPISODES_COLLECTION = 'notification-center:alert-episodes'

const NC_ALERT_EPISODES_COLUMNS = [
  { name: 'episodeId', type: 'TEXT' as const, primaryKey: true, notNull: true },
  /** The kind that was notified: `alert-critical` or `alert-error`. */
  { name: 'kind', type: 'TEXT' as const, notNull: true },
  { name: 'alertId', type: 'TEXT' as const, notNull: true },
  { name: 'since', type: 'INTEGER' as const, notNull: true },
] as const

/** Longer than the alert centre's maximum retention (365 days). */
export const NC_ALERT_EPISODE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000

export type NcAlertEpisodeKind = 'alert-critical' | 'alert-error'

export interface NcAlertEpisodeRow {
  readonly episodeId: string
  readonly kind: NcAlertEpisodeKind
  readonly alertId: string
  readonly since: number
}

function isEpisodeKind(value: unknown): value is NcAlertEpisodeKind {
  return value === 'alert-critical' || value === 'alert-error'
}

const NC_ALERT_EPISODES_SPEC: DurableLedgerSpec<NcAlertEpisodeRow> = {
  collection: NC_ALERT_EPISODES_COLLECTION,
  columns: NC_ALERT_EPISODES_COLUMNS,
  writeMode: 'write-behind',
  keyOf: (row) => row.episodeId,
  toValue: (row) => ({
    kind: row.kind,
    alertId: row.alertId,
    since: row.since,
  }),
  fromRecord: (key, data) => {
    const kind = data['kind']
    const alertId = data['alertId']
    const since = data['since']
    if (!isEpisodeKind(kind) || typeof alertId !== 'string' || typeof since !== 'number') {
      return null
    }
    return { episodeId: key, kind, alertId, since }
  },
}

/** What the ledger decides about one announced edge. */
export type NcAlertEpisodeVerdict =
  /** Notify it: the system event goes to the rules. */
  | 'notify'
  /** Already notified (a re-emit, or the other path got there first). */
  | 'duplicate'
  /** Closed an `alert-error` episode: the row is dropped, nothing is sent. */
  | 'closed-silently'
  /** A closing for an episode this centre never notified. */
  | 'unknown-episode'

export interface NcAlertEpisodeEdge {
  /** The system-event kind the edge maps to, `null` when it announces nothing. */
  readonly kind: NcSystemEventKind | null
  readonly phase: 'raised' | 'resolved'
  readonly episodeId: string
  readonly alertId: string
}

export interface NcAlertEpisodeLedgerDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
}

export class NcAlertEpisodeLedger {
  private readonly ledger: DurableLedger<NcAlertEpisodeRow>

  constructor(deps: NcAlertEpisodeLedgerDeps) {
    this.ledger = new DurableLedger({
      spec: NC_ALERT_EPISODES_SPEC,
      kind: deps.records.kind(ncDurableRecordKinds['alert-episodes']),
      logger: deps.logger,
    })
  }

  async load(): Promise<number> {
    return (await this.ledger.load()).length
  }

  /** Has a load READ the store once? Until then the mirror is not the truth. */
  hasAnswered(): boolean {
    return this.ledger.hasAnswered()
  }

  has(episodeId: string): boolean {
    return this.ledger.has(episodeId)
  }

  snapshot(): readonly NcAlertEpisodeRow[] {
    return this.ledger.snapshot()
  }

  /**
   * Judge one announced edge and advance the ledger. Synchronous: the verdict
   * is a function of the mirror (D49); the durable write trails it.
   */
  admit(edge: NcAlertEpisodeEdge, now: number): NcAlertEpisodeVerdict {
    const held = this.ledger.get(edge.episodeId)
    if (edge.phase === 'raised') {
      if (edge.kind !== 'alert-critical' && edge.kind !== 'alert-error') return 'duplicate'
      if (held !== undefined && (held.kind === 'alert-critical' || edge.kind === 'alert-error')) {
        return 'duplicate'
      }
      void this.ledger.put({
        episodeId: edge.episodeId,
        kind: edge.kind,
        alertId: edge.alertId,
        since: held?.since ?? now,
      })
      return 'notify'
    }
    if (held === undefined) return 'unknown-episode'
    void this.ledger.forget(edge.episodeId)
    return held.kind === 'alert-critical' && edge.kind === 'alert-critical-resolved'
      ? 'notify'
      : 'closed-silently'
  }

  /** Drop rows older than the alert centre could still hold the alert. */
  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const keep = new Set(
      this.ledger
        .snapshot()
        .filter((row) => row.since >= cutoffMs)
        .map((row) => row.episodeId),
    )
    return this.ledger.pruneExcept(keep)
  }
}
