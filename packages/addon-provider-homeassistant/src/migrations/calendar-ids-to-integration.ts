/**
 * The HA calendars an instance imports are a fact of THAT instance (D985): each Home Assistant
 * integration carries its own `calendarIds` in its settings, and the addon-level `calendarIds`
 * setting (one set of `calendar.*` entity ids for every broker) goes away.
 *
 * Two migrations, in this order:
 *
 * 1. `calendar-ids-to-integration` (procedure) copies the shared set to EVERY integration that
 *    has no `calendarIds` yet. An integration that already has one is never overwritten; one
 *    deleted meanwhile is skipped, never recreated; a stored value that is not a list of strings
 *    is an ambiguity and throws (nothing is guessed).
 * 2. `drop-shared-calendar-ids` (plan) deletes the shared setting after a read-back: every
 *    integration must show its own set. When one holds a set that differs from the shared one,
 *    the shared value is the loser and stays PARKED in place, never deleted.
 *
 * Both are idempotent.
 */
import {
  type MigrationPlan,
  type MigrationProcedureResult,
  preconditionOf,
  type StoredKeyRead,
} from '@camstack/types'
import type { HaInstanceSettingsPorts } from '../ha-instance-settings.js'

export const HA_PROVIDER_ID = 'provider-homeassistant'

/** The canonical settings table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

export const SHARED_CALENDAR_IDS_KEY = 'calendarIds'

export interface CalendarIdsPorts extends HaInstanceSettingsPorts {
  /** The addon's stored setting as written (three-way: a failed read is not "absent"). */
  readStored(key: string): Promise<StoredKeyRead>
}

async function readSharedSet(ports: CalendarIdsPorts): Promise<readonly string[] | null> {
  const answer = await ports.readStored(SHARED_CALENDAR_IDS_KEY)
  if (answer.kind === 'unreadable') {
    throw new Error(
      `provider-homeassistant: the shared calendarIds cannot be read (${answer.reason})`,
    )
  }
  if (answer.kind === 'absent') return null
  const value: unknown = answer.value
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(
      'provider-homeassistant: the shared calendarIds is not a list of entity ids — nothing copied',
    )
  }
  return value
}

export async function copyCalendarIdsToIntegrations(
  ports: CalendarIdsPorts,
): Promise<MigrationProcedureResult> {
  const shared = await readSharedSet(ports)
  if (shared === null) return { outcome: 'already-done', summary: { reason: 'no-shared-set' } }
  let copied = 0
  let kept = 0
  let gone = 0
  for (const instance of await ports.listInstances()) {
    if (SHARED_CALENDAR_IDS_KEY in instance.settings) {
      kept += 1
      continue
    }
    if (await ports.patchInstanceSettings(instance.integrationId, { calendarIds: [...shared] })) {
      copied += 1
    } else {
      gone += 1
    }
  }
  return { outcome: copied === 0 ? 'already-done' : 'done', summary: { copied, kept, gone } }
}

const asIds = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : null

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((id) => right.has(id))
}

export async function planDropSharedCalendarIds(ports: CalendarIdsPorts): Promise<MigrationPlan> {
  const shared = await readSharedSet(ports)
  if (shared === null) return { edits: [] }
  const instances = await ports.listInstances()
  // No integration carries the set: deleting it would lose it.
  if (instances.length === 0) return { edits: [] }
  const own = instances.map((instance) => ({
    integrationId: instance.integrationId,
    ids: asIds(instance.settings[SHARED_CALENDAR_IDS_KEY]),
  }))
  const missing = own.filter((entry) => entry.ids === null)
  if (missing.length > 0) {
    throw new Error(
      `provider-homeassistant: the shared calendarIds is not dropped, ${missing.map((m) => m.integrationId).join(', ')} has no set of its own`,
    )
  }
  if (!own.every((entry) => sameSet(entry.ids ?? [], shared))) return { edits: [] }
  const rowId = `${HA_PROVIDER_ID}.${SHARED_CALENDAR_IDS_KEY}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: [rowId],
        precondition: preconditionOf({
          [rowId]: { addonId: HA_PROVIDER_ID, key: SHARED_CALENDAR_IDS_KEY, value: shared },
        }),
      },
    ],
  }
}
