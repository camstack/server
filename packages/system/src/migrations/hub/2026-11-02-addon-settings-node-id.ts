/**
 * D986 / W3-1: stamp `nodeId` on the node rows of `addon-settings`.
 *
 * A node row is `<addonId>.<field>@<nodeId>` with data `{ addonId, key, value }`. From D986 on it
 * also carries `nodeId`, so forgetting a node is ONE central `deleteWhere({ where: { nodeId } })`.
 * Rows written before that lack the field; this migration adds it, parsed from the `@<nodeId>`
 * suffix of the key. Nothing else about a row changes: the id, `addonId`, `key` and `value` (and
 * any other field a neighbouring writer put in the JSON) are kept as they are.
 *
 * A `plan` body: it reads, the engine applies the edit in the migration's own transaction under a
 * precondition on what was read. A row that already carries a `nodeId`, is not an object, or has
 * no `@<nodeId>` suffix is left alone, so a second run edits nothing.
 */
import { nodeIdOfScopedKey } from '@camstack/types/addon'
import { preconditionOf, type MigrationMeta } from '@camstack/types'
import type {
  HubPlanMigration,
  MigrationDatabase,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

const TABLE = 'addon-settings'

export const ADDON_SETTINGS_NODE_ID_MIGRATION_ID = 'hub/2026-11-02-addon-settings-node-id'

const META: MigrationMeta = {
  id: ADDON_SETTINGS_NODE_ID_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 1,
  dependsOn: [],
  store: 'settings',
  scope: 'cluster',
  onFailure: 'block-owner',
  bodyKind: 'plan',
  description:
    'Stamp nodeId, parsed from the @<nodeId> suffix of the key, on the node rows of addon-settings',
  fixtureMark: 'value',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsed(data: unknown): unknown {
  if (typeof data !== 'string') return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function hasTable(db: MigrationDatabase): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', TABLE) !==
    undefined
  )
}

interface StampedRow {
  readonly id: string
  readonly before: Record<string, unknown>
  readonly after: Record<string, unknown>
}

function stampedRows(db: MigrationDatabase): readonly StampedRow[] {
  const out: StampedRow[] = []
  const rows = db.prepare(`SELECT id, data FROM "${TABLE}" WHERE instr(id, '@') > 0`).all()
  for (const row of rows) {
    if (!isRecord(row) || typeof row['id'] !== 'string') continue
    const data = parsed(row['data'])
    if (!isRecord(data) || 'nodeId' in data) continue
    const key = typeof data['key'] === 'string' ? data['key'] : row['id']
    const nodeId = nodeIdOfScopedKey(key)
    if (nodeId === null) continue
    out.push({ id: row['id'], before: data, after: { ...data, nodeId } })
  }
  return out
}

export const ADDON_SETTINGS_NODE_ID_MIGRATION: HubPlanMigration = {
  meta: META,
  plan(db) {
    if (!hasTable(db)) return { edits: [] }
    const rows = stampedRows(db)
    if (rows.length === 0) return { edits: [] }
    return {
      edits: [
        {
          op: 'setKeys',
          scope: TABLE,
          values: Object.fromEntries(rows.map((row) => [row.id, row.after])),
          precondition: preconditionOf(Object.fromEntries(rows.map((row) => [row.id, row.before]))),
        },
      ],
    }
  },
}
