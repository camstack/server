/**
 * Drop the retired storage leftovers that the records move left behind (planning#328, D987).
 *
 * Two hub-store `sql` steps, not one: a migration names a single file, and these leftovers do not
 * share one. The three `pipeline-analytics:*` shells are settings-store collections (a
 * `declareCollection` with no `database` lands in `camstack.db`; the kinds that replaced them
 * still default to `settings`). `vec_object_clip` is the unsuffixed CLIP index, and every vector
 * index lives in `events.db` (P5), where the worker has already loaded sqlite-vec before this
 * body runs. `pipeline-analytics` no longer declares the tables, so the hub owns the drop.
 *
 * Each named table is dropped only when it exists and has 0 rows. A non-empty table stays, and
 * the ledger note names it `kept-nonempty`. `DROP TABLE` on the vec0 virtual table removes its
 * shadow tables; when the virtual table is already gone, each empty shadow is dropped on its
 * own. The `vec_indexes` row whose id is the unsuffixed `object-clip` index is removed only when
 * that index is empty. A suffixed index (`vec_object_clip_siglip2_*`) is never named here.
 * A second run finds nothing and changes nothing. `tolerate`: a node without these tables boots.
 */
import type { MigrationMeta } from '@camstack/types'
import type {
  HubSqlMigration,
  MigrationDatabase,
  MigrationNote,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

export const DROP_RETIRED_SETTINGS_SHELLS_MIGRATION_ID =
  'hub/2026-11-12-drop-retired-settings-shells'
export const DROP_RETIRED_VEC_OBJECT_CLIP_MIGRATION_ID =
  'hub/2026-11-12-drop-retired-vec-object-clip'

/** Physical collection tables nothing declares any more (the kinds live in `records`). */
export const RETIRED_SETTINGS_SHELLS = [
  'pipeline-analytics:package-background',
  'pipeline-analytics:phantom-cells',
  'pipeline-analytics:stationary-evidence',
] as const

/** The unsuffixed CLIP virtual table. Not `vec_object_clip_siglip2_*`. */
export const RETIRED_VEC_TABLE = 'vec_object_clip'

/**
 * sqlite-vec's shadow tables for {@link RETIRED_VEC_TABLE}. Dropped with the virtual table;
 * dropped one by one only when the virtual table row is already gone.
 */
export const RETIRED_VEC_SHADOWS = [
  'vec_object_clip_auxiliary',
  'vec_object_clip_chunks',
  'vec_object_clip_info',
  'vec_object_clip_metadatachunks00',
  'vec_object_clip_metadatachunks01',
  'vec_object_clip_metadatachunks02',
  'vec_object_clip_metadatachunks03',
  'vec_object_clip_metadatatext02',
  'vec_object_clip_metadatatext03',
  'vec_object_clip_rowids',
  'vec_object_clip_vector_chunks00',
] as const

const VEC_INDEXES = 'vec_indexes'

/** What one table did. The engine logs the note at info, one key per table. */
export type RetiredTableOutcome = 'absent' | 'dropped' | 'kept-nonempty'

const SETTINGS_META: MigrationMeta = {
  id: DROP_RETIRED_SETTINGS_SHELLS_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 8,
  dependsOn: [],
  store: 'settings',
  scope: 'cluster',
  onFailure: 'tolerate',
  bodyKind: 'sql',
  description:
    'Drop the empty pipeline-analytics package-background, phantom-cells and stationary-evidence tables',
  fixtureMark: 'kept-nonempty',
}

const EVENTS_META: MigrationMeta = {
  id: DROP_RETIRED_VEC_OBJECT_CLIP_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 9,
  dependsOn: [],
  store: 'events',
  scope: 'cluster',
  onFailure: 'tolerate',
  bodyKind: 'sql',
  description:
    'Drop the empty unsuffixed vec_object_clip index and its vec_indexes row, leaving siglip2 in place',
  fixtureMark: 'siglip2',
}

function tableNames(db: MigrationDatabase): ReadonlySet<string> {
  const names = new Set<string>()
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (typeof row !== 'object' || row === null) continue
    const name: unknown = Reflect.get(row, 'name')
    if (typeof name === 'string') names.add(name)
  }
  return names
}

function rowCount(db: MigrationDatabase, name: string): number {
  const row: unknown = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()
  const n: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'n') : undefined
  return typeof n === 'number' ? n : 0
}

function dropIfEmpty(
  db: MigrationDatabase,
  name: string,
  present: ReadonlySet<string>,
): RetiredTableOutcome {
  if (!present.has(name)) return 'absent'
  if (rowCount(db, name) > 0) return 'kept-nonempty'
  db.exec(`DROP TABLE "${name}"`)
  return 'dropped'
}

function forgetDeclaration(db: MigrationDatabase, name: string): void {
  if (!tableNames(db).has('_collection_declarations')) return
  db.prepare('DELETE FROM _collection_declarations WHERE name = ?').run(name)
}

/** The vec0 table name an index id declares (`object-clip` and `vec_object_clip` agree). */
function vecTableOfIndexId(indexId: string): string {
  const bare = indexId.startsWith('vec_') ? indexId.slice('vec_'.length) : indexId
  return `vec_${bare.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

function dropIndexRow(db: MigrationDatabase, indexEmpty: boolean): RetiredTableOutcome {
  const present = tableNames(db)
  if (!present.has(VEC_INDEXES)) return 'absent'
  if (!indexEmpty) return 'kept-nonempty'
  const ids: string[] = []
  for (const row of db.prepare(`SELECT id FROM "${VEC_INDEXES}"`).all()) {
    if (typeof row !== 'object' || row === null) continue
    const id: unknown = Reflect.get(row, 'id')
    if (typeof id === 'string' && vecTableOfIndexId(id) === RETIRED_VEC_TABLE) ids.push(id)
  }
  if (ids.length === 0) return 'absent'
  const remove = db.prepare(`DELETE FROM "${VEC_INDEXES}" WHERE id = ?`)
  for (const id of ids) remove.run(id)
  return 'dropped'
}

function dropVec(db: MigrationDatabase): MigrationNote {
  const present = tableNames(db)
  const outcomes: Record<string, RetiredTableOutcome> = {}
  const virtual = present.has(RETIRED_VEC_TABLE) ? rowCount(db, RETIRED_VEC_TABLE) : null
  if (virtual === null) {
    outcomes[RETIRED_VEC_TABLE] = 'absent'
    for (const shadow of RETIRED_VEC_SHADOWS) {
      outcomes[shadow] = dropIfEmpty(db, shadow, present)
    }
  } else if (virtual > 0) {
    outcomes[RETIRED_VEC_TABLE] = 'kept-nonempty'
    for (const shadow of RETIRED_VEC_SHADOWS) {
      if (present.has(shadow)) outcomes[shadow] = 'kept-nonempty'
    }
  } else {
    db.exec(`DROP TABLE "${RETIRED_VEC_TABLE}"`)
    outcomes[RETIRED_VEC_TABLE] = 'dropped'
    const after = tableNames(db)
    for (const shadow of RETIRED_VEC_SHADOWS) {
      if (!present.has(shadow)) {
        outcomes[shadow] = 'absent'
        continue
      }
      outcomes[shadow] = after.has(shadow) ? dropIfEmpty(db, shadow, after) : 'dropped'
    }
  }
  outcomes[`${VEC_INDEXES}:${RETIRED_VEC_TABLE}`] = dropIndexRow(
    db,
    outcomes[RETIRED_VEC_TABLE] !== 'kept-nonempty',
  )
  return outcomes
}

function dropShells(db: MigrationDatabase): MigrationNote {
  const present = tableNames(db)
  const outcomes: Record<string, RetiredTableOutcome> = {}
  for (const name of RETIRED_SETTINGS_SHELLS) {
    const outcome = dropIfEmpty(db, name, present)
    if (outcome === 'dropped') forgetDeclaration(db, name)
    outcomes[name] = outcome
  }
  return outcomes
}

export const DROP_RETIRED_SETTINGS_SHELLS_MIGRATION: HubSqlMigration = {
  meta: SETTINGS_META,
  run: dropShells,
}

export const DROP_RETIRED_VEC_OBJECT_CLIP_MIGRATION: HubSqlMigration = {
  meta: EVENTS_META,
  run: dropVec,
}
