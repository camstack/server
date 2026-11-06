/**
 * Rewrite the BARE rows of `addon-settings` into the canonical shape.
 *
 * The canonical row is `<addonId>.<key>` with data `{ addonId, key, value }` (plus `nodeId` on a
 * node-scoped key). A few rows were stored as the bare value itself (a JSON `[]` at
 * `google-services.brokers`): reads tolerate that through `unwrapStoredValue`, but every addon
 * migration plan rebuilds its precondition from the UNWRAPPED value as `{ addonId, key, value }`,
 * so over a bare row the engine's comparison against the stored data can never hold and the plan
 * fails on every boot.
 *
 * A row is rewritten when its data is not already canonical: `addonId` and `key` come from the id
 * (split on the FIRST '.'), `value` is the bare data, and `nodeId` is added for a node-scoped key.
 * Reading is unchanged: `unwrapStoredValue` answers the same value before and after.
 *
 * Left alone, because rewriting could change what a read answers or the row is not ours to guess:
 * - a record that has its own `value` field (it already reads as a wrapper, or is a bare record
 *   whose own `value` field a wrap would hide: ambiguous, so nothing is touched);
 * - a record carrying `addonId` and `key` without `value` (a corrupt wrapper);
 * - data that is not JSON, and an id with no addonId before its first '.'.
 *
 * A `plan` body: it reads, the engine applies the edit under a precondition on the rows as read.
 * A second run finds every row canonical and plans nothing.
 */
import { nodeIdOfScopedKey } from '@camstack/types/addon'
import { preconditionOf, type MigrationMeta } from '@camstack/types'
import type {
  HubPlanMigration,
  MigrationDatabase,
} from '../../builtins/sqlite-storage/migrations/migration-types.js'

const TABLE = 'addon-settings'

export const ADDON_SETTINGS_BARE_ROWS_MIGRATION_ID = 'hub/2026-11-06-addon-settings-bare-rows'

const META: MigrationMeta = {
  id: ADDON_SETTINGS_BARE_ROWS_MIGRATION_ID,
  owner: 'hub',
  level: 'hub-store',
  seq: 6,
  dependsOn: [],
  store: 'settings',
  scope: 'cluster',
  onFailure: 'block-owner',
  bodyKind: 'plan',
  description:
    'Wrap the addon-settings rows stored as a bare value into { addonId, key, value } so addon migration preconditions can hold',
  fixtureMark: 'value',
}

interface Parsed {
  readonly value: unknown
}

function parsed(data: unknown): Parsed | null {
  if (typeof data !== 'string') return null
  try {
    return { value: JSON.parse(data) }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasTable(db: MigrationDatabase): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', TABLE) !==
    undefined
  )
}

/** `true` when the data is a record that must not be touched (see the file comment). */
function isLeftAlone(data: unknown): boolean {
  if (!isRecord(data)) return false
  return 'value' in data || ('addonId' in data && 'key' in data)
}

interface WrappedRow {
  readonly id: string
  readonly before: unknown
  readonly after: Record<string, unknown>
}

function wrappedRows(db: MigrationDatabase): readonly WrappedRow[] {
  const out: WrappedRow[] = []
  for (const row of db.prepare(`SELECT id, data FROM "${TABLE}"`).all()) {
    if (!isRecord(row) || typeof row['id'] !== 'string') continue
    const read = parsed(row['data'])
    if (read === null || isLeftAlone(read.value)) continue
    const dot = row['id'].indexOf('.')
    if (dot <= 0) continue
    const addonId = row['id'].slice(0, dot)
    const key = row['id'].slice(dot + 1)
    const nodeId = nodeIdOfScopedKey(key)
    out.push({
      id: row['id'],
      before: read.value,
      after:
        nodeId === null
          ? { addonId, key, value: read.value }
          : { addonId, key, value: read.value, nodeId },
    })
  }
  return out
}

export const ADDON_SETTINGS_BARE_ROWS_MIGRATION: HubPlanMigration = {
  meta: META,
  plan(db) {
    if (!hasTable(db)) return { edits: [] }
    const rows = wrappedRows(db)
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
