/**
 * A record kind is owned by the ADDON id, which never changes. Before the hub verified the addon a
 * grouped runner acts for, the records engine took the owner from the connection stamp, which for a
 * grouped runner is the GROUP id (`net-access`, `integrations`), so the kinds of a grouped addon
 * were declared under the group. This migration re-owns them: `_record_kinds.owner` goes from the
 * group id to the addon id; the rows follow through `kind_id`, so nothing else is rewritten.
 *
 * The map is static and names only the (group, kind) pairs a grouped addon is known to have
 * declared. It is idempotent: a second run finds no group-owned kind. When the addon already owns
 * a kind of the same name, two catalogues exist for one kind: when only one side holds rows the
 * empty declaration is discarded and the other is kept under the addon id; both empty keeps the
 * addon-owned one; rows on BOTH sides: the side with the NEWER newest updatedAt is the live one and
 * is kept under the addon id, the other is renamed `<kind>~superseded-<owner>` under the addon id
 * (never deleted, its rows stay recoverable); an EQUAL newest updatedAt writes NOTHING and fails
 * naming each side's row count and newest updatedAt. A row holding a keychain marker minted under the group is refused too:
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

interface KindLoad {
  readonly rows: number
  readonly newestUpdatedAt: number | null
}

function loadOf(db: MigrationDatabase, kindId: number): KindLoad {
  const row = db
    .prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS newest FROM records WHERE kind_id = ?')
    .get(kindId)
  if (typeof row !== 'object' || row === null) return { rows: 0, newestUpdatedAt: null }
  const n: unknown = Reflect.get(row, 'n')
  const newest: unknown = Reflect.get(row, 'newest')
  return {
    rows: typeof n === 'number' ? n : 0,
    newestUpdatedAt: typeof newest === 'number' ? newest : null,
  }
}

const SUPERSEDED_INFIX = '~superseded-'

function describeSide(owner: string, load: KindLoad): string {
  return `${owner}: ${load.rows} row(s), newest updatedAt ${load.newestUpdatedAt ?? 'none'}`
}

/**
 * Decides one move WITHOUT writing: returns the writes to apply, or throws when both owners hold
 * rows of the kind with the same newest updatedAt. Exactly one side with rows wins (the empty declaration is discarded), both
 * empty keeps the addon-owned one.
 */
function planMove(db: MigrationDatabase, m: GroupKind & { readonly kindId: number }): () => void {
  const addonKindId = kindIdOf(db, m.addonId, m.kind)
  const reown = (): void => {
    db.prepare('UPDATE _record_kinds SET owner = ? WHERE kind_id = ?').run(m.addonId, m.kindId)
  }
  if (addonKindId === null) return reown
  const group = loadOf(db, m.kindId)
  const addon = loadOf(db, addonKindId)
  const discard = (kindId: number): void => {
    db.prepare('DELETE FROM _record_sequences WHERE kind_id = ?').run(kindId)
    db.prepare('DELETE FROM _record_kinds WHERE kind_id = ?').run(kindId)
  }
  if (group.rows > 0 && addon.rows > 0) {
    const groupNewest = group.newestUpdatedAt ?? 0
    const addonNewest = addon.newestUpdatedAt ?? 0
    if (groupNewest === addonNewest) {
      throw new Error(
        `record kind "${m.kind}" exists under both owners with rows on both and the same newest updatedAt, nothing was re-owned: ${describeSide(m.group, group)}; ${describeSide(m.addonId, addon)}. Remove the side to discard, then retry.`,
      )
    }
    // The newer side is the live one. The loser is never deleted: its kind row is renamed under the
    // addon id, so its rows stay on disk, unreachable by the live kind, recoverable by hand.
    const loserOwner = groupNewest > addonNewest ? m.addonId : m.group
    const loserKindId = groupNewest > addonNewest ? addonKindId : m.kindId
    const supersededKind = `${m.kind}${SUPERSEDED_INFIX}${loserOwner}`
    return () => {
      db.prepare('UPDATE _record_kinds SET owner = ?, kind = ? WHERE kind_id = ?').run(
        m.addonId,
        supersededKind,
        loserKindId,
      )
      if (groupNewest > addonNewest) reown()
    }
  }
  if (group.rows > 0) {
    return () => {
      discard(addonKindId)
      reown()
    }
  }
  return () => discard(m.kindId)
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
    const writes = moves.map((m) => planMove(db, m))
    for (const group of new Set(moves.map((m) => m.group))) {
      if (hasGroupMarker(db, group)) {
        throw new Error(
          `a record under owner ${group} holds a keychain marker minted under ${group}; nothing was re-owned. Re-enter that secret on its addon, then retry.`,
        )
      }
    }
    for (const write of writes) write()
  },
}
