/**
 * The rows of the Calendars list: every calendar a source answers, joined with the `calendar`
 * instance record behind it, plus the records whose calendar the sources no longer answer (a
 * switched-off one) so they stay in the list and can be switched back on. Pure.
 *
 * A source stamps its calendar id as `<addonId>:<local>`, where `<local>` is the record's
 * calendar id (a connection that lists entities) or `<accountId>:<calendarId>` (an account).
 * The record carries `accountId` and `calendarId` in its form values, so the join tries both.
 */
import type { CalendarEntry } from '@camstack/types'
import type { HolderData } from '../instances/instances-model'

export interface CalendarInstanceRef {
  readonly addonId: string
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly providerName: string
  /** The cluster-stable calendar ids this record can answer as. */
  readonly entryIds: readonly string[]
}

export interface CalendarListRow {
  readonly key: string
  readonly name: string
  readonly providerName: string
  /** Absent: the sources do not answer this calendar (switched off or not signed in). */
  readonly calendar: CalendarEntry | null
  /** Absent: no record behind it, so no switch. */
  readonly instance: CalendarInstanceRef | null
}

function text(values: Readonly<Record<string, unknown>>, key: string): string {
  const v = values[key]
  return typeof v === 'string' ? v : ''
}

export function calendarInstanceRefs(
  holders: readonly HolderData[],
  displayNames: ReadonlyMap<string, string>,
): readonly CalendarInstanceRef[] {
  return holders.flatMap((holder) =>
    holder.instances.map((inst) => {
      const accountId = text(inst.formValues, 'accountId')
      const calendarId = text(inst.formValues, 'calendarId')
      const entryIds =
        calendarId === ''
          ? []
          : [
              `${holder.addonId}:${calendarId}`,
              ...(accountId === '' ? [] : [`${holder.addonId}:${accountId}:${calendarId}`]),
            ]
      return {
        addonId: holder.addonId,
        id: inst.id,
        name: inst.name,
        enabled: inst.enabled !== false,
        providerName: displayNames.get(holder.addonId) ?? holder.addonId,
        entryIds,
      }
    }),
  )
}

export function joinCalendarRows(
  calendars: readonly CalendarEntry[],
  instances: readonly CalendarInstanceRef[],
  providerLabel: (cal: CalendarEntry) => string,
): readonly CalendarListRow[] {
  const claimed = new Set<string>()
  const rows: CalendarListRow[] = calendars.map((calendar) => {
    const instance = instances.find((i) => i.entryIds.includes(calendar.id)) ?? null
    if (instance !== null) claimed.add(instance.id)
    return {
      key: calendar.id,
      name: calendar.name,
      providerName: instance?.providerName ?? providerLabel(calendar),
      calendar,
      instance,
    }
  })
  for (const instance of instances) {
    if (claimed.has(instance.id)) continue
    rows.push({
      key: `instance:${instance.id}`,
      name: instance.name,
      providerName: instance.providerName,
      calendar: null,
      instance,
    })
  }
  return rows
}
