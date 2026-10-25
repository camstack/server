/**
 * Which database files a backup carries, and when (D852).
 *
 * Settings is the one a decision reads and runs nightly. Events and history are
 * statistical or ledger stores; losing up to a week costs chart gaps, never
 * configuration, so they ride a WEEKLY schedule whose archive is a consistent
 * full set. Pure functions, no I/O: the orchestrator feeds them what it read.
 */
import type { DataStoreDatabase } from '@camstack/types'
import { DEFAULT_BACKUP_DATABASES } from '../system-backup/system-backup.service.js'
import type { BackupSchedule } from './schedule-store.js'
import type { SeedMarkers } from './seed-marker-store.js'

/** Stable id of the seeded weekly schedule. */
export const WEEKLY_SCHEDULE_ID = 'weekly-events-history'
export const WEEKLY_SCHEDULE_LABEL = 'Weekly — events & history'
/** Sundays 04:00 — an hour after the nightly settings run. */
export const WEEKLY_SCHEDULE_CRON = '0 4 * * 0'
export const WEEKLY_SCHEDULE_RETENTION = 4
/**
 * Events and history ONLY: a run that does not select settings carries no
 * data-root walk either, so the weekly archive is just the two snapshots.
 */
export const WEEKLY_SCHEDULE_DATABASES: readonly DataStoreDatabase[] = ['events', 'history']

/** What a schedule carries: its own list, else the minimum (D382). */
export function databasesOfSchedule(
  schedule: Pick<BackupSchedule, 'databases'>,
): readonly DataStoreDatabase[] {
  return schedule.databases !== undefined && schedule.databases.length > 0
    ? schedule.databases
    : DEFAULT_BACKUP_DATABASES
}

/**
 * True when a run asks for a database beyond settings and the owner has none
 * of them open: the run would only repeat the nightly archive. A settings-only
 * run is never nothing-to-carry.
 */
export function hasNothingBeyondSettings(
  requested: readonly DataStoreDatabase[],
  owned: readonly DataStoreDatabase[],
): boolean {
  const extra = requested.filter((id) => id !== 'settings')
  if (extra.length === 0) return false
  return !extra.some((id) => owned.includes(id))
}

/**
 * The weekly schedule to seed, or null. Created only when NO schedule carries
 * `events` (a seed never overwrites, D728 — an operator's own weekly schedule,
 * or an edited seed, is left alone), and only when there is a nightly schedule
 * to take the destinations from: a hub that backs up nowhere gets no weekly
 * archive either.
 */
export function planWeeklySeed(existing: readonly BackupSchedule[]): BackupSchedule | null {
  if (existing.some((s) => s.id === WEEKLY_SCHEDULE_ID)) return null
  if (existing.some((s) => databasesOfSchedule(s).includes('events'))) return null
  const destinations = new Set<string>()
  for (const s of existing) {
    if (!s.enabled) continue
    for (const id of s.locationIds) destinations.add(id)
  }
  if (destinations.size === 0) return null
  return {
    id: WEEKLY_SCHEDULE_ID,
    label: WEEKLY_SCHEDULE_LABEL,
    cron: WEEKLY_SCHEDULE_CRON,
    enabled: true,
    locationIds: [...destinations].toSorted(),
    retentionCount: WEEKLY_SCHEDULE_RETENTION,
    databases: WEEKLY_SCHEDULE_DATABASES,
  }
}

/** The slice of the schedule store the seed needs. */
export interface ScheduleSeedStore {
  list(): Promise<readonly BackupSchedule[]>
  upsert(schedule: BackupSchedule): Promise<void>
}

/**
 * Seed the weekly schedule if {@link planWeeklySeed} says so; returns what it
 * wrote. Exactly once ever: the marker is written after the row, and a marker
 * that exists ends the seed for good — an operator who disabled or deleted the
 * weekly is never second-guessed. A weekly row found with no marker (seeded
 * before the marker existed) is marked, not re-created.
 */
export async function seedWeeklySchedule(
  store: ScheduleSeedStore,
  markers: SeedMarkers,
): Promise<BackupSchedule | null> {
  if (await markers.has(WEEKLY_SCHEDULE_ID)) return null
  const existing = await store.list()
  if (existing.some((s) => s.id === WEEKLY_SCHEDULE_ID)) {
    await markers.mark(WEEKLY_SCHEDULE_ID)
    return null
  }
  const seed = planWeeklySeed(existing)
  if (seed === null) return null
  await store.upsert(seed)
  await markers.mark(WEEKLY_SCHEDULE_ID)
  return seed
}
