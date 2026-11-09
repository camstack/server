/**
 * The rows of the Calendars list: every calendar a source answers, joined with the `calendar`
 * instance record behind it, plus the records whose calendar the sources no longer answer (a
 * switched-off one) so they stay in the list and can be switched back on. Pure.
 *
 * Every calendar carries the id of the record that owns it (`instanceId`, stamped by the source
 * from the record it read the calendar from), so the join is the pair (providing addon, record
 * id) and never an id rebuilt from form values.
 */
import type { CalendarEntry } from '@camstack/types'
import type { HolderData } from '../instances/instances-model'

export interface CalendarInstanceRef {
  readonly addonId: string
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly providerName: string
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

export function calendarInstanceRefs(
  holders: readonly HolderData[],
  displayNames: ReadonlyMap<string, string>,
): readonly CalendarInstanceRef[] {
  return holders.flatMap((holder) =>
    holder.instances.map((inst) => ({
      addonId: holder.addonId,
      id: inst.id,
      name: inst.name,
      enabled: inst.enabled !== false,
      providerName: displayNames.get(holder.addonId) ?? holder.addonId,
    })),
  )
}

export function joinCalendarRows(
  calendars: readonly CalendarEntry[],
  instances: readonly CalendarInstanceRef[],
  providerLabel: (cal: CalendarEntry) => string,
): readonly CalendarListRow[] {
  const claimed = new Set<string>()
  const keyOf = (addonId: string, instanceId: string): string => `${addonId}\u0000${instanceId}`
  const rows: CalendarListRow[] = calendars.map((calendar) => {
    const instance =
      calendar.instanceId === undefined
        ? null
        : (instances.find(
            (i) => i.addonId === calendar.providerAddonId && i.id === calendar.instanceId,
          ) ?? null)
    if (instance !== null) claimed.add(keyOf(instance.addonId, instance.id))
    return {
      // The record is the row's identity: two connections can answer the same entity id.
      key: instance === null ? calendar.id : `instance:${instance.addonId}:${instance.id}`,
      name: calendar.name,
      providerName: instance?.providerName ?? providerLabel(calendar),
      calendar,
      instance,
    }
  })
  for (const instance of instances) {
    if (claimed.has(keyOf(instance.addonId, instance.id))) continue
    rows.push({
      key: `instance:${instance.addonId}:${instance.id}`,
      name: instance.name,
      providerName: instance.providerName,
      calendar: null,
      instance,
    })
  }
  return rows
}
