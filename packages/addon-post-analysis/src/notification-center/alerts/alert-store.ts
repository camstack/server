/**
 * The durable home of {@link NcAlertRow} — one row per sustained-alert subject.
 *
 * Mechanics are `DurableLedger` (`../../durable/`), exactly as
 * `NcLivenessLedger` uses it; what lives here is the part only this family
 * knows: the columns, and what counts as the same fact.
 *
 * ## Why it is durable at all
 *
 * A reminder is a claim about how long something has been true, and a RAM-only
 * memory of that makes a restart indistinguishable from a recovery: the episode
 * would re-open, the "battery low" would be re-announced as if it were new, and
 * the reminder clock would restart. That is the same failure the liveness
 * ledger was written for, one family over.
 *
 * ## Bounded by the installation
 *
 * One row per subject that has ever been observed with a readable battery. On
 * this hub that is at most 70 (the devices carrying a `battery` slice), and it
 * cannot exceed the device count. Like the liveness ledger it is NOT pruned
 * against the device directory: a prune is durable state destroyed on a
 * fallible read (D49).
 */

import type { IScopedLogger } from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../../durable/durable-ledger.js'
import { type DurableKindDeps } from '../../durable/durable-wiring.js'
import { ncDurableRecordKinds } from '../nc-durable-record-kinds.js'
import { BootWindowRows } from '../boot-window-rows.js'
import { alertSubjectDeviceId, type NcAlertRow } from './alert-episode.js'
import type { NcAlertRowPort } from './device-alerts.js'

/**
 * @durable class=ledger owner=notification-center
 *   write="one row per alert subject, rewritten on every state transition and on every reminder; a silent repeat writes nothing"
 *   retention="none, deliberately — one row per device that has ever reported a readable battery, bounded by the installation (70 of 1014 devices measured 2026-09-01)."
 */
const NC_ALERTS_COLLECTION = 'notification-center:device-alerts'

const NC_ALERTS_COLUMNS = [
  /** `battery:<deviceId>` — the family is part of the key so a second family
   *  can be added without a migration. */
  { name: 'subject', type: 'TEXT' as const, primaryKey: true, notNull: true },
  /** 1 while the subject is in the state worth notifying about. */
  { name: 'alerting', type: 'INTEGER' as const, notNull: true },
  /** When the CURRENT episode opened. Part of the outbox record id, so it is
   *  what separates two episodes of one subject. */
  { name: 'since', type: 'INTEGER' as const, notNull: true },
  /** When we last actually sent something. 0 = never (a silent seed). */
  { name: 'lastNotifiedAt', type: 'INTEGER' as const, notNull: true },
  /** How many reminders this episode has produced. Every transition resets it. */
  { name: 'reminders', type: 'INTEGER' as const, notNull: true },
  /** Indexed: every question about an alert is asked per-device. */
  { name: 'deviceId', type: 'INTEGER' as const },
  /** What the open episode is — a provider consumable band (D647 review M6). Nullable, added in place. */
  { name: 'detail', type: 'TEXT' as const },
] as const

const NC_ALERTS_INDEXES = [
  { name: 'idx_nc_alerts_device', columns: ['deviceId'] as const },
] as const

/** The device a subject is about — see {@link alertSubjectDeviceId}. */
function deviceIdOf(subject: string): number | undefined {
  return alertSubjectDeviceId(subject)
}

const NC_ALERTS_SPEC: DurableLedgerSpec<NcAlertRow> = {
  collection: NC_ALERTS_COLLECTION,
  columns: NC_ALERTS_COLUMNS,
  indexes: NC_ALERTS_INDEXES,
  writeMode: 'write-behind',
  keyOf: (row) => row.subject,
  toValue: (row) => ({
    subject: row.subject,
    alerting: row.alerting ? 1 : 0,
    since: row.since,
    lastNotifiedAt: row.lastNotifiedAt,
    reminders: row.reminders,
    ...(deviceIdOf(row.subject) !== undefined ? { deviceId: deviceIdOf(row.subject) } : {}),
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
  }),
  fromRecord: (key, data) => {
    const since = data['since']
    const lastNotifiedAt = data['lastNotifiedAt']
    const reminders = data['reminders']
    if (typeof since !== 'number') return null
    if (typeof lastNotifiedAt !== 'number') return null
    if (typeof reminders !== 'number') return null
    const detail = data['detail']
    return {
      subject: key,
      alerting: data['alerting'] === 1 || data['alerting'] === true,
      since,
      lastNotifiedAt,
      reminders,
      ...(typeof detail === 'string' ? { detail } : {}),
    }
  },
  // The FACT is the state. `lastNotifiedAt` and `reminders` move on every
  // reminder and must not make each one look like a transition — the same
  // reason the liveness spec compares the state and not the kind.
  equalFact: (held, incoming) => held.alerting === incoming.alerting,
  deviceIdOf: (row) => deviceIdOf(row.subject),
}

/**
 * Which row the boot settle keeps for one subject observed inside the window
 * (D698's rule, applied to the alert ledger).
 *
 * The store's row is the episode the previous process knew; the provisional
 * one is what this process concluded before it could read it. A different
 * STATE means the condition moved while we were down — the provisional row is
 * the truth. The same state keeps the stored episode (its `since` is the
 * outbox identity of what was already said) unless this process has since
 * SPOKEN about it more recently: then the provisional row records that speech,
 * and dropping it would re-offer an alert that was just delivered.
 */
export function mergeBootWindowAlertRow(
  stored: NcAlertRow | undefined,
  provisional: NcAlertRow,
): NcAlertRow {
  if (stored === undefined || stored.alerting !== provisional.alerting) return provisional
  return provisional.lastNotifiedAt > stored.lastNotifiedAt ? provisional : stored
}

export class NcAlertStore {
  private readonly ledger: DurableLedger<NcAlertRow>
  /**
   * THE BOOT WINDOW (D698). Battery slices arrive from the moment the centre
   * starts, and the ledger is read only in the back-fill. A row written in that
   * gap used to be wiped by the load, which REPLACES the mirror: a raise no rule
   * matched lost its pending row, and nothing re-offered it until the device
   * wrote a new slice — never, on a sensor that reports once (review C1 of
   * D636). Inside the window a row is staged, never persisted, and the settle
   * merges it with the stored one ({@link mergeBootWindowAlertRow}).
   */
  private readonly bootWindow: BootWindowRows<NcAlertRow>

  constructor(deps: DurableKindDeps & { readonly logger: IScopedLogger }) {
    this.ledger = new DurableLedger({
      spec: NC_ALERTS_SPEC,
      kind: deps.records.kind(ncDurableRecordKinds['device-alerts']),
      logger: deps.logger,
    })
    this.bootWindow = new BootWindowRows({
      ledger: this.ledger,
      keyOf: (row) => row.subject,
      deviceIdOf: (row) => deviceIdOf(row.subject),
      logger: deps.logger,
      merge: mergeBootWindowAlertRow,
    })
  }

  /** Boot reseed. A failed load KEEPS whatever is mirrored — never clears. */
  async load(): Promise<number> {
    const loaded = (await this.ledger.load()).length
    this.bootWindow.settle()
    return loaded
  }

  /** Drop a deleted device's mirrored rows (the durable ones go by `deleteWhere`, D871). */
  evictDevice(deviceId: number): number {
    return this.ledger.evictDevice(deviceId)
  }

  /**
   * The port `NcDeviceAlerts` consumes. Deliberately narrow: the service knows
   * nothing about SQLite, and a spec hands it a Map.
   */
  port(): NcAlertRowPort {
    return {
      get: (subject) => this.ledger.get(subject),
      // Write-behind: the mirror advances synchronously inside `put`, so the
      // NEXT observation is already compared against the new row even while
      // SQLite is slow. The persist is deliberately not awaited here — the
      // caller is on the event path, and a failed write costs at most one
      // re-seed on the next boot (a silence, never a flood), which is the
      // liveness ledger's stated bargain.
      put: (row) => {
        // Inside the boot window a row is PROVISIONAL — never persisted over
        // a stored row the load has not read yet (D698).
        if (this.bootWindow.open()) {
          this.bootWindow.stageProvisional(row)
          return
        }
        void this.ledger.put(row).catch(() => undefined)
      },
      all: () => this.ledger.snapshot(),
      remove: (subject) => {
        if (this.bootWindow.open()) this.bootWindow.noteRemoved(subject)
        return this.ledger.forget(subject)
      },
      answered: () => this.ledger.hasAnswered(),
    }
  }
}
