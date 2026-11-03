/**
 * The calendars a Google account imports are a fact of THAT account (D985): each broker record
 * carries its own `calendarIds`, and the addon-level `calendarIds` setting (one shared set of
 * `<brokerId>:<googleCalendarId>` ids) goes away.
 *
 * Two migrations, in this order:
 *
 * 1. `calendar-ids-to-brokers` (procedure) copies the shared set to EVERY broker record that has
 *    no `calendarIds` yet. A record that already has one is never overwritten; a broker deleted
 *    meanwhile is skipped, never recreated; a stored value that is not a list of strings is an
 *    ambiguity and throws (nothing is guessed).
 * 2. `drop-shared-calendar-ids` (plan) deletes the shared setting, but only after a read-back:
 *    every live broker must show its own `calendarIds`. When one of them holds a set that differs
 *    from the shared one (an operator choice made before the copy), the shared value is the
 *    loser and stays PARKED where it is, never deleted.
 *
 * Both are idempotent: with the copy landed the first reports `already-done`, and with the row
 * gone the second plans nothing.
 */
import {
  type MigrationPlan,
  type MigrationProcedureResult,
  preconditionOf,
  type StoredKeyRead,
} from '@camstack/types'

export const GOOGLE_ADDON_ID = 'google-services'

/** The canonical settings table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

/** The legacy shared set. */
export const SHARED_CALENDAR_IDS_KEY = 'calendarIds'

export interface BrokerCalendarRecord {
  readonly id: string
  /** `undefined`: the record carries no set of its own yet. */
  readonly calendarIds: readonly string[] | undefined
}

export interface CalendarIdsPorts {
  /** The addon's stored setting as written (three-way: a failed read is not "absent"). */
  readStored(key: string): Promise<StoredKeyRead>
  /** Every Google broker record, as stored. */
  listBrokers(): Promise<readonly BrokerCalendarRecord[]>
  /** Give a record its set unless it has one already; `false` when the record is gone. */
  setBrokerCalendarIds(id: string, ids: readonly string[]): Promise<boolean>
}

async function readSharedSet(ports: CalendarIdsPorts): Promise<readonly string[] | null> {
  const answer = await ports.readStored(SHARED_CALENDAR_IDS_KEY)
  if (answer.kind === 'unreadable') {
    throw new Error(`google-services: the shared calendarIds cannot be read (${answer.reason})`)
  }
  if (answer.kind === 'absent') return null
  const value: unknown = answer.value
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error('google-services: the shared calendarIds is not a list of ids — nothing copied')
  }
  return value
}

export async function copyCalendarIdsToBrokers(
  ports: CalendarIdsPorts,
): Promise<MigrationProcedureResult> {
  const shared = await readSharedSet(ports)
  if (shared === null) return { outcome: 'already-done', summary: { reason: 'no-shared-set' } }
  let copied = 0
  let kept = 0
  let gone = 0
  for (const broker of await ports.listBrokers()) {
    if (broker.calendarIds !== undefined) {
      kept += 1
      continue
    }
    if (await ports.setBrokerCalendarIds(broker.id, shared)) copied += 1
    else gone += 1
  }
  return { outcome: copied === 0 ? 'already-done' : 'done', summary: { copied, kept, gone } }
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((id) => right.has(id))
}

export async function planDropSharedCalendarIds(ports: CalendarIdsPorts): Promise<MigrationPlan> {
  const shared = await readSharedSet(ports)
  if (shared === null) return { edits: [] }
  const brokers = await ports.listBrokers()
  // No broker carries the set: deleting it would lose it.
  if (brokers.length === 0) return { edits: [] }
  const missing = brokers.filter((broker) => broker.calendarIds === undefined)
  if (missing.length > 0) {
    throw new Error(
      `google-services: the shared calendarIds is not dropped, ${missing.map((b) => b.id).join(', ')} has no set of its own`,
    )
  }
  if (!brokers.every((broker) => sameSet(broker.calendarIds ?? [], shared))) return { edits: [] }
  const rowId = `${GOOGLE_ADDON_ID}.${SHARED_CALENDAR_IDS_KEY}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: [rowId],
        precondition: preconditionOf({
          [rowId]: { addonId: GOOGLE_ADDON_ID, key: SHARED_CALENDAR_IDS_KEY, value: shared },
        }),
      },
    ],
  }
}
