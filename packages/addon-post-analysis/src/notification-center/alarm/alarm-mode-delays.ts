/**
 * The persisted per-mode delay overrides, read through a guard (D697).
 *
 * The panel's config schema keeps `mode` a plain string so a blob written by a later release
 * with a mode this one does not know cannot fail the whole config. This is where that string is
 * narrowed: an entry that cannot be trusted is dropped and REPORTED, never repaired. An entry of an unknown
 * mode is also handed back raw (`foreign`) so a write can keep it.
 */
import {
  AlarmArmModeSchema,
  NC_ALARM_DELAY_MAX_SEC,
  NC_ALARM_TRIGGERED_MAX_SEC,
  NcAlarmPostTriggeredActionSchema,
  NcScheduleSchema,
  type NcAlarmDelayField,
  type NcAlarmModeDelays,
  type NcAlarmPostTriggeredAction,
  type NcSchedule,
} from '@camstack/types'

/** One persisted entry as the loose panel schema hands it over. */
export interface NcPersistedModeDelays {
  readonly mode: string
  readonly exitDelaySec?: number
  readonly entryDelaySec?: number
  readonly triggeredDurationSec?: number
  readonly postTriggeredAction?: string
  readonly schedule?: unknown
  readonly notifyDuringEntryDelay?: boolean
  readonly notifySensorRewatched?: boolean
  readonly notifySensorIgnored?: boolean
}
export type NcAlarmModeDelaysDropReason = 'unknown-mode' | 'duplicate-mode' | 'out-of-bounds'
export interface NcAlarmModeDelaysDrop {
  readonly mode: string
  readonly why: NcAlarmModeDelaysDropReason
  readonly field?: NcAlarmDelayField | 'schedule'
}
export interface NcAlarmModeDelaysRead {
  readonly entries: NcAlarmModeDelays[]
  readonly dropped: readonly NcAlarmModeDelaysDrop[]
  /**
   * The raw entries whose mode this release does not know — typically written by a later
   * release. An edit writes them back untouched: the guard narrows what is READ, an edit
   * must not erase what it did not understand.
   */
  readonly foreign: readonly NcPersistedModeDelays[]
}

function inBounds(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max
}

/** Read the persisted overrides through a guard, never a cast (like `nonBlockingFromPersisted`). */
export function modeDelaysFromPersisted(
  raw: readonly NcPersistedModeDelays[],
): NcAlarmModeDelaysRead {
  const seen = new Set<string>()
  const entries: NcAlarmModeDelays[] = []
  const dropped: NcAlarmModeDelaysDrop[] = []
  const foreign: NcPersistedModeDelays[] = []
  for (const item of raw) {
    const mode = AlarmArmModeSchema.safeParse(item.mode)
    if (!mode.success) {
      dropped.push({ mode: item.mode, why: 'unknown-mode' })
      foreign.push(item)
      continue
    }
    if (seen.has(mode.data)) {
      dropped.push({ mode: item.mode, why: 'duplicate-mode' })
      continue
    }
    seen.add(mode.data)
    const kept: NcAlarmModeDelays = { mode: mode.data }
    const fields: readonly { field: NcAlarmDelayField; max: number }[] = [
      { field: 'exitDelaySec', max: NC_ALARM_DELAY_MAX_SEC },
      { field: 'entryDelaySec', max: NC_ALARM_DELAY_MAX_SEC },
      { field: 'triggeredDurationSec', max: NC_ALARM_TRIGGERED_MAX_SEC },
    ]
    for (const { field, max } of fields) {
      const value = item[field]
      if (value === undefined) continue
      if (!inBounds(value, max)) {
        dropped.push({ mode: item.mode, why: 'out-of-bounds', field })
        continue
      }
      kept[field] = value
    }
    if (item.postTriggeredAction !== undefined) {
      const action = NcAlarmPostTriggeredActionSchema.safeParse(item.postTriggeredAction)
      if (action.success) kept.postTriggeredAction = action.data
      else dropped.push({ mode: item.mode, why: 'out-of-bounds', field: 'triggeredDurationSec' })
    }
    if (item.schedule !== undefined) {
      const schedule = NcScheduleSchema.safeParse(item.schedule)
      if (schedule.success) kept.schedule = schedule.data
      else dropped.push({ mode: item.mode, why: 'out-of-bounds', field: 'schedule' })
    }
    // D706: booleans by the loose schema already; carried as they are.
    if (item.notifyDuringEntryDelay !== undefined) {
      kept.notifyDuringEntryDelay = item.notifyDuringEntryDelay
    }
    if (item.notifySensorRewatched !== undefined) {
      kept.notifySensorRewatched = item.notifySensorRewatched
    }
    if (item.notifySensorIgnored !== undefined) {
      kept.notifySensorIgnored = item.notifySensorIgnored
    }
    if (
      kept.notifyDuringEntryDelay !== undefined ||
      kept.notifySensorRewatched !== undefined ||
      kept.notifySensorIgnored !== undefined ||
      kept.exitDelaySec !== undefined ||
      kept.entryDelaySec !== undefined ||
      kept.triggeredDurationSec !== undefined ||
      kept.postTriggeredAction !== undefined ||
      kept.schedule !== undefined
    ) {
      entries.push(kept)
    }
  }
  return { entries, dropped, foreign }
}

/** Re-export for callers that persist a narrowed action string. */
export type { NcAlarmPostTriggeredAction, NcSchedule }
