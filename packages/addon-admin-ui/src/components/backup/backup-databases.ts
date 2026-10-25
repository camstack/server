/**
 * What a backup carries — the selection model of the Backup page.
 *
 * Pure functions: the schedule editor, the "Back up now" dialog, the archive
 * list and the restore wizard all read the same labels and defaults here, so a
 * database is never named two ways. The rule behind the defaults is the
 * server's: an unstated selection is `['settings']` (the nightly), and a run
 * that does not select settings is a snapshots-only archive.
 * `docs/architecture/backups.md` → "Which databases, and how often".
 */
import type { DataStoreDatabase } from '@camstack/types'
import i18n from '../../i18n/index'

interface DatabaseOption {
  readonly labelKey: string
  readonly descriptionKey: string
  readonly shortKey: string
}

/** Every database, in the server's stable order (settings first). */
const OPTIONS = {
  settings: {
    labelKey: 'helpers.backupDatabases.settings.label',
    descriptionKey: 'helpers.backupDatabases.settings.description',
    shortKey: 'helpers.backupDatabases.settings.short',
  },
  events: {
    labelKey: 'helpers.backupDatabases.events.label',
    descriptionKey: 'helpers.backupDatabases.events.description',
    shortKey: 'helpers.backupDatabases.events.short',
  },
  history: {
    labelKey: 'helpers.backupDatabases.history.label',
    descriptionKey: 'helpers.backupDatabases.history.description',
    shortKey: 'helpers.backupDatabases.history.short',
  },
} as const satisfies Record<DataStoreDatabase, DatabaseOption>

export const BACKUP_DATABASE_IDS = Object.keys(OPTIONS) as readonly DataStoreDatabase[]

/** What a new schedule, a manual run and a legacy row carry. */
export const DEFAULT_DATABASE_SELECTION: readonly DataStoreDatabase[] = ['settings']

/** Hint on a database that does not exist on this hub yet. */
export function notCreatedHint(): string {
  return i18n.t('helpers.backupDatabases.notCreated')
}

export function databaseLabel(id: DataStoreDatabase): string {
  return i18n.t(OPTIONS[id].labelKey)
}

/** One-word name for compact lists; the caller uppercases it with CSS. */
export function databaseShortLabel(id: DataStoreDatabase): string {
  return i18n.t(OPTIONS[id].shortKey)
}

export function databaseDescription(id: DataStoreDatabase): string {
  return i18n.t(OPTIONS[id].descriptionKey)
}

/** Selection in the server's stable order, duplicates dropped. */
export function orderedSelection(
  selected: Iterable<DataStoreDatabase>,
): readonly DataStoreDatabase[] {
  const set = new Set(selected)
  return BACKUP_DATABASE_IDS.filter((id) => set.has(id))
}

/** What an existing row carries: its list, and NULL / empty means settings. */
export function selectionOfRow(
  databases: readonly DataStoreDatabase[] | undefined,
): readonly DataStoreDatabase[] {
  return databases !== undefined && databases.length > 0
    ? orderedSelection(databases)
    : DEFAULT_DATABASE_SELECTION
}

/**
 * The `databases` field to write for a selection. The default selection is
 * still written explicitly: a stored list is unambiguous, and the server reads
 * an absent one as the same minimum.
 */
export function databasesPayload(
  selected: ReadonlySet<DataStoreDatabase>,
): readonly DataStoreDatabase[] {
  return orderedSelection(selected)
}

export type DatabasePresence = 'present' | 'absent' | 'unknown'

/** What `backup.listAvailableDatabases` answered (`answered: false` = unknown). */
export interface AvailableDatabases {
  readonly answered: boolean
  readonly databases: readonly DataStoreDatabase[]
}

/**
 * Whether a database exists on this hub. An unanswered query (loading, or an
 * owner that did not reply) is `unknown`, never `absent`: not-yet-known must
 * not look like not-created.
 */
export function databasePresence(
  id: DataStoreDatabase,
  available: AvailableDatabases | undefined,
): DatabasePresence {
  if (available === undefined || !available.answered) return 'unknown'
  return available.databases.includes(id) ? 'present' : 'absent'
}

/** A database the operator cannot newly tick: absent, and not already selected. */
export function isDatabaseDisabled(
  id: DataStoreDatabase,
  available: AvailableDatabases | undefined,
  selected: ReadonlySet<DataStoreDatabase>,
): boolean {
  return databasePresence(id, available) === 'absent' && !selected.has(id)
}

/** Toggle one database in a selection, returning a new set. */
export function toggleDatabase(
  selected: ReadonlySet<DataStoreDatabase>,
  id: DataStoreDatabase,
): ReadonlySet<DataStoreDatabase> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** A run that does not select settings carries no configuration or data file. */
export function isSnapshotsOnly(databases: readonly DataStoreDatabase[]): boolean {
  return !databases.includes('settings')
}

/** The `backup.trigger` input of a manual run: the selection, nothing else. */
export interface BackupTriggerSelection {
  readonly databases: DataStoreDatabase[]
}

export function triggerInputFor(selected: ReadonlySet<DataStoreDatabase>): BackupTriggerSelection {
  return { databases: [...databasesPayload(selected)] }
}

/** The slice of an archive manifest that names its database snapshots. */
export interface ArchiveSnapshotRef {
  readonly databaseId?: DataStoreDatabase
}

/**
 * The databases an archive carries: what its run asked for (the index entry),
 * else the owners' snapshots its manifest lists, else settings — an archive
 * made before several files were owned carried that one.
 */
export function databasesOfArchive(
  asked: readonly DataStoreDatabase[] | undefined,
  snapshots: readonly ArchiveSnapshotRef[] | undefined,
): readonly DataStoreDatabase[] {
  if (asked !== undefined && asked.length > 0) return orderedSelection(asked)
  if (snapshots !== undefined && snapshots.length > 0) {
    return orderedSelection(snapshots.map((s) => s.databaseId ?? 'settings'))
  }
  return DEFAULT_DATABASE_SELECTION
}
