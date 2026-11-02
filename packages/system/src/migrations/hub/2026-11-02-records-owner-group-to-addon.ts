/**
 * A record kind is owned by the ADDON id, which never changes. Before the hub verified the addon a
 * grouped runner acts for, the records engine took the owner from the connection stamp, which for a
 * grouped runner is the GROUP id (`net-access`, `integrations`), so the kinds of a grouped addon
 * were declared under the group. This migration re-owns them: `_record_kinds.owner` goes from the
 * group id to the addon id; the rows follow through `kind_id`, so nothing else is rewritten.
 *
 * The map is static and names only the (group, kind) pairs a grouped addon is known to have
 * declared. It is idempotent: a second run finds no group-owned kind. When the addon already owns
 * a kind of the same name (the addon declared it again after the fix), two catalogues exist for one
 * kind and the migration writes NOTHING, failing naming both owners: choosing which rows survive
 * is an operator decision. A row holding a keychain marker minted under the group is refused too:
 * the keychain lives outside this database, so its ref cannot be moved from here.
 */
import type { MigrationMeta } from '@camstack/types'
import type {
  HubSqlMigration,
  MigrationDatabase,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

export const RECORDS_OWNER_GROUP_TO_ADDON_MIGRATION_ID =
  'hub/2026-11-02-records-owner-group-to-addon'

const META: MigrationMeta = {
  id: RECORDS_OWNER_GROUP_TO_ADDON_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 3,
  dependsOn: [],
  store: 'settings',
  scope: 'cluster',
  // A clash or a group-minted marker needs the operator, and must not keep the hub from booting.
  onFailure: 'tolerate',
  bodyKind: 'sql',
  description:
    'Re-own record kinds declared under an execution group id to the addon id; the rows follow their kind',
  fixtureMark: 'mark',
}

interface GroupKind {
  readonly group: string
  readonly kind: string
  readonly addonId: string
}

/** Every (group, kind) a grouped addon declared; solo-runner addons were always stamped by id. */
export const GROUPED_RECORD_KINDS: readonly GroupKind[] = [
  { group: 'net-access', kind: 'servers', addonId: 'static-turn' },
  { group: 'net-access', kind: 'accounts', addonId: 'cloudflare-turn' },
  { group: 'integrations', kind: 'waste-source', addonId: 'waste-collections' },
]

function hasTable(db: MigrationDatabase, name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !==
    undefined
  )
}

function kindIdOf(db: MigrationDatabase, owner: string, kind: string): number | null {
  const row = db
    .prepare('SELECT kind_id FROM _record_kinds WHERE owner = ? AND kind = ?')
    .get(owner, kind)
  if (typeof row !== 'object' || row === null) return null
  const kindId: unknown = Reflect.get(row, 'kind_id')
  return typeof kindId === 'number' ? kindId : null
}

function hasGroupMarker(db: MigrationDatabase, group: string): boolean {
  const owned = db.prepare('SELECT kind_id FROM _record_kinds WHERE owner = ?').all(group)
  const marker = `secret://${group}/`
  for (const k of owned) {
    if (typeof k !== 'object' || k === null) continue
    const kindId: unknown = Reflect.get(k, 'kind_id')
    if (typeof kindId !== 'number') continue
    const hit = db
      .prepare('SELECT 1 FROM records WHERE kind_id = ? AND instr(json(data), ?) > 0 LIMIT 1')
      .get(kindId, marker)
    if (hit !== undefined) return true
  }
  return false
}

export const RECORDS_OWNER_GROUP_TO_ADDON_MIGRATION: HubSqlMigration = {
  meta: META,
  run(db) {
    if (!hasTable(db, 'records') || !hasTable(db, '_record_kinds')) return
    const moves = GROUPED_RECORD_KINDS.flatMap((g) => {
      const kindId = kindIdOf(db, g.group, g.kind)
      return kindId === null ? [] : [{ ...g, kindId }]
    })
    if (moves.length === 0) return
    const clashes = moves.filter((m) => kindIdOf(db, m.addonId, m.kind) !== null)
    if (clashes.length > 0) {
      throw new Error(
        `a record kind exists under both owners, nothing was re-owned: ${clashes
          .map((m) => `"${m.kind}" under ${m.group} and ${m.addonId}`)
          .join('; ')}. Remove the one to discard, then retry.`,
      )
    }
    const groups = new Set(moves.map((m) => m.group))
    for (const group of groups) {
      if (hasGroupMarker(db, group)) {
        throw new Error(
          `a record under owner ${group} holds a keychain marker minted under ${group}; nothing was re-owned. Re-enter that secret on its addon, then retry.`,
        )
      }
    }
    const update = db.prepare('UPDATE _record_kinds SET owner = ? WHERE kind_id = ?')
    for (const m of moves) update.run(m.addonId, m.kindId)
  },
}
