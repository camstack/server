/**
 * The calendars an account imports leave the account (D1013). An account record used to carry a
 * `calendarIds` array; each calendar is now a record of its own that LINKS to the account
 * (`calendars`, one per account and calendar). For every account row with an array:
 *
 *  1. each entry becomes a calendar record under a deterministic id (an existing one is kept);
 *  2. each record is read back and must name this account and calendar;
 *  3. only then is the array cleared (a patch: nothing else on the account is touched).
 *
 * An entry that names another account, or is not a calendar id at all, selected nothing before
 * (the reader only matched its own account's ids): it is counted, named in a warning and goes with
 * the array. An array that is not a list of strings is left where it is. A failure on one account
 * does not stop the others; the run then throws, and the accounts that failed keep their array.
 * Accounts are never created or deleted. Idempotent: with the arrays cleared nothing is left to do.
 */
import { createHash } from 'node:crypto'
import type { MigrationProcedureResult } from './migration.js'
import type { RowsMigrationLog } from './integration-rows-to-record.js'

export interface AccountCalendarRow {
  readonly id: string
  /** The stored value as written; `undefined` when the row has none. */
  readonly calendarIds: unknown
}

export interface CalendarRecordBody {
  readonly name: string
  readonly accountId: string
  readonly calendarId: string
}

export interface CalendarRecordPorts extends RowsMigrationLog {
  listAccounts(): Promise<readonly AccountCalendarRow[]>
  /** The calendar record under `recordId`; null when there is none. */
  readCalendar(recordId: string): Promise<CalendarRecordBody | null>
  /** Insert (never overwrite) the record; throws when the write fails. */
  putCalendar(recordId: string, body: CalendarRecordBody): Promise<void>
  /** Remove the `calendarIds` field of one account row, touching nothing else. */
  clearCalendarIds(accountId: string): Promise<void>
}

export interface CalendarIdsSpec {
  /** The calendar id one stored entry means for `accountId`; null when it means none of its own. */
  calendarIdOf(accountId: string, entry: string): string | null
}

/** The id of the calendar record of one (account, calendar): the same pair is always the same row. */
export function calendarRecordId(accountId: string, calendarId: string): string {
  const digest = createHash('sha1').update(`${accountId}\0${calendarId}`).digest('hex')
  return `cal_${digest.slice(0, 16)}`
}

function entriesOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

export async function moveCalendarIdsToRecords(
  ports: CalendarRecordPorts,
  spec: CalendarIdsSpec,
): Promise<MigrationProcedureResult> {
  let created = 0
  let cleared = 0
  let dropped = 0
  const failed: string[] = []
  for (const account of await ports.listAccounts()) {
    if (account.calendarIds === undefined || account.calendarIds === null) continue
    const entries = entriesOf(account.calendarIds)
    if (entries === null) {
      ports.warn(`account '${account.id}': calendarIds is not a list of ids and stays as it is`)
      failed.push(account.id)
      continue
    }
    try {
      const own = new Set<string>()
      const inert: string[] = []
      for (const entry of entries) {
        const calendarId = spec.calendarIdOf(account.id, entry)
        if (calendarId === null || calendarId === '') inert.push(entry)
        else own.add(calendarId)
      }
      for (const calendarId of own) {
        const recordId = calendarRecordId(account.id, calendarId)
        const body: CalendarRecordBody = { name: calendarId, accountId: account.id, calendarId }
        if ((await ports.readCalendar(recordId)) === null) {
          await ports.putCalendar(recordId, body)
          created += 1
        }
        const back = await ports.readCalendar(recordId)
        if (back?.accountId !== account.id || back.calendarId !== calendarId) {
          throw new Error(
            `account '${account.id}': the calendar record '${recordId}' did not read back; the array stays`,
          )
        }
      }
      if (inert.length > 0) {
        ports.warn(
          `account '${account.id}': ${inert.length} entr${inert.length === 1 ? 'y' : 'ies'} of calendarIds named another account or no calendar and selected nothing: ${inert.join(', ')}`,
        )
        dropped += inert.length
      }
      await ports.clearCalendarIds(account.id)
      cleared += 1
    } catch (error) {
      ports.warn(error instanceof Error ? error.message : String(error))
      failed.push(account.id)
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `calendarIds kept on ${failed.length} account(s) (${failed.join(', ')}); ${created} calendar record(s) written, ${cleared} account(s) cleared`,
    )
  }
  return {
    outcome: created === 0 && cleared === 0 ? 'already-done' : 'done',
    summary: { created, cleared, dropped },
  }
}
